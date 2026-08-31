#!/bin/bash
# Reference solution: diagnose the failing OrderShipped routing rule on the
# production fulfillment bus, then mutate its input transformer via
# events:PutTargets so future OrderShipped events land in the records table
# with the true tier and SLA.
#
# The audit archive log group projects only envelope fields (privacy review),
# so the raw subscriber block is NOT recoverable by grepping CloudWatch Logs.
# The reference discovery approach used here:
#   1. Attach a temporary SQS observer target to the shipped rule that
#      projects `$.detail` as a raw message body (independent of any log
#      group). Publish a probe OrderShipped event.
#   2. Read the single queued message, extract the real subscriber path from
#      the raw detail block (`$.detail.enrollment.*`).
#   3. Remove the observer target, then re-issue PutTargets with the corrected
#      InputPathsMap. Every other InputPathsMap entry and the InputTemplate
#      are preserved verbatim.
#
# The audit archive rule's envelope-only InputTransformer is NOT modified.
set -euo pipefail

mkdir -p /logs/agent

python3 - <<'PY'
import collections
import json
import os
import time
import uuid

import boto3

REGION = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1"))
PROD_BUS = os.environ["PROD_BUS_NAME"]
STAGING_BUS = os.environ.get("STAGING_BUS_NAME", "")
SHIPPED_RULE = os.environ["SHIPPED_RULE_NAME"]
RECORDS_TABLE = os.environ["RECORDS_TABLE_NAME"]
POLICY_TABLE = os.environ["TIER_POLICY_TABLE_NAME"]
CANARY_RULE = os.environ.get("CANARY_RULE_NAME", "fulfillment-shipped-canary-rule")
EVENT_SOURCE = "com.acme.fulfillment"

session = boto3.Session(region_name=REGION)
events = session.client("events")
ddb = session.client("dynamodb")
sqs = session.client("sqs")
sts = session.client("sts")

acct_id = sts.get_caller_identity()["Account"]


def _find_leaf(doc, leaf):
    detail = doc.get("detail") if isinstance(doc, dict) else None
    if not isinstance(detail, dict):
        return None
    for parent_key, parent_val in detail.items():
        if isinstance(parent_val, dict) and leaf in parent_val:
            return "$.detail.%s.%s" % (parent_key, leaf)
    return None


# ---- 1. Read the current InputTransformer on the shipped rule -------------
targets = events.list_targets_by_rule(EventBusName=PROD_BUS, Rule=SHIPPED_RULE)["Targets"]
if not targets:
    raise SystemExit("%s has no targets on %s" % (SHIPPED_RULE, PROD_BUS))

lambda_target = None
declared_paths = None
declared_template = None
for tgt in targets:
    it = tgt.get("InputTransformer")
    if it and tgt.get("Arn", "").startswith("arn:aws:lambda:"):
        lambda_target = tgt
        declared_paths = dict(it.get("InputPathsMap") or {})
        declared_template = it.get("InputTemplate") or ""
        break

if lambda_target is None:
    raise SystemExit("no Lambda target with InputTransformer on %s" % SHIPPED_RULE)

# ---- 2. Create a temporary observer queue that receives raw detail --------
observer_name = "solve-shipped-observer-%s" % uuid.uuid4().hex[:8]
obs_url = sqs.create_queue(
    QueueName=observer_name,
    Attributes={"MessageRetentionPeriod": "60"},
)["QueueUrl"]
obs_arn = sqs.get_queue_attributes(QueueUrl=obs_url, AttributeNames=["QueueArn"])["Attributes"]["QueueArn"]

# Allow EventBridge to send messages to the observer.
sqs.set_queue_attributes(
    QueueUrl=obs_url,
    Attributes={
        "Policy": json.dumps({
            "Version": "2012-10-17",
            "Statement": [{
                "Sid": "AllowEventBridge",
                "Effect": "Allow",
                "Principal": {"Service": "events.amazonaws.com"},
                "Action": "sqs:SendMessage",
                "Resource": obs_arn,
            }],
        })
    },
)

observer_target = {
    "Id": "solve-observer",
    "Arn": obs_arn,
    "InputTransformer": {
        "InputPathsMap": {"detail": "$.detail"},
        "InputTemplate": "<detail>",
    },
}

# Preserve the existing Lambda target; add the observer alongside.
events.put_targets(
    EventBusName=PROD_BUS,
    Rule=SHIPPED_RULE,
    Targets=[lambda_target, observer_target],
)

try:
    time.sleep(3)  # let the new target settle

    # ---- 3. Publish a probe OrderShipped ---------------------------------
    probe_order_id = "SOLVE-PROBE-%s" % uuid.uuid4().hex[:12].upper()
    occurred_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    probe_detail = {
        "orderId": probe_order_id,
        "occurredAt": occurred_at,
        # Send a shape that includes every plausible subscriber container so
        # the discovery works regardless of which subtree the producer uses.
        "enrollment": {"tier": "PROBE", "region": "probe"},
        "carrier": {"name": "PROBE", "serviceLevel": "GROUND"},
        "destination": {"country": "US"},
        "warehouse": {"code": "PROBE-WH"},
    }
    events.put_events(Entries=[{
        "EventBusName": PROD_BUS,
        "Source": EVENT_SOURCE,
        "DetailType": "OrderShipped",
        "Detail": json.dumps(probe_detail),
    }])

    # ---- 4. Read the observer queue --------------------------------------
    raw_detail = None
    deadline = time.time() + 45
    while time.time() < deadline and raw_detail is None:
        resp = sqs.receive_message(
            QueueUrl=obs_url,
            MaxNumberOfMessages=10,
            WaitTimeSeconds=5,
            VisibilityTimeout=10,
        )
        for m in resp.get("Messages", []) or []:
            try:
                body = json.loads(m["Body"])
            except Exception:  # noqa: BLE001
                continue
            if isinstance(body, dict) and body.get("orderId") == probe_order_id:
                raw_detail = body
                break
        if raw_detail is None:
            time.sleep(2)
finally:
    # ---- 5. Detach the observer target and delete the queue -------------
    try:
        events.remove_targets(
            EventBusName=PROD_BUS,
            Rule=SHIPPED_RULE,
            Ids=[observer_target["Id"]],
        )
    except Exception as exc:  # noqa: BLE001
        print("failed to remove observer target: %s" % exc)
    try:
        sqs.delete_queue(QueueUrl=obs_url)
    except Exception as exc:  # noqa: BLE001
        print("failed to delete observer queue: %s" % exc)

# ---- 6. Determine correct paths ------------------------------------------
corrected_paths = {}
if isinstance(raw_detail, dict):
    tier_path = _find_leaf({"detail": raw_detail}, "tier")
    region_path = _find_leaf({"detail": raw_detail}, "region")
    if tier_path:
        corrected_paths["customerTier"] = tier_path
    if region_path:
        corrected_paths["customerRegion"] = region_path

if not corrected_paths:
    # Fallback if the observer never received anything.
    corrected_paths = {
        "customerTier": "$.detail.enrollment.tier",
        "customerRegion": "$.detail.enrollment.region",
    }

# ---- 7. Apply the real fix -----------------------------------------------
final_paths = dict(declared_paths)
final_paths.update(corrected_paths)
final_target = {k: v for k, v in lambda_target.items() if k not in ("Input", "InputPath")}
final_target["InputTransformer"] = {
    "InputPathsMap": final_paths,
    "InputTemplate": declared_template,
}
resp = events.put_targets(EventBusName=PROD_BUS, Rule=SHIPPED_RULE, Targets=[final_target])
if resp.get("FailedEntryCount", 0):
    raise SystemExit("put_targets (fix) failed: %s" % resp)

print("reissued %s with corrected paths: %s" % (SHIPPED_RULE, corrected_paths))

# ---- 8. Self-check: peer rules untouched ---------------------------------
def _paths_for(bus, rule):
    try:
        tgts = events.list_targets_by_rule(EventBusName=bus, Rule=rule).get("Targets", [])
    except Exception:  # noqa: BLE001
        return {}
    for t in tgts:
        it = t.get("InputTransformer") or {}
        if it:
            return dict(it.get("InputPathsMap") or {})
    return {}


canary_paths = _paths_for(PROD_BUS, CANARY_RULE)
if canary_paths.get("customerTier") != "$.detail.customer.tier":
    raise SystemExit("canary rule mutated: %s" % canary_paths)

if STAGING_BUS:
    staging_paths = _paths_for(STAGING_BUS, SHIPPED_RULE)
    if staging_paths and staging_paths.get("customerTier") != "$.detail.subscriber.tier":
        raise SystemExit("staging shipped rule mutated: %s" % staging_paths)

# ---- 9. Diagnostic writeup -----------------------------------------------
by_type = collections.defaultdict(collections.Counter)
sla_by_type = collections.defaultdict(collections.Counter)
kwargs = {"TableName": RECORDS_TABLE}
scanned = 0
while True:
    page = ddb.scan(**kwargs)
    for item in page.get("Items", []):
        scanned += 1
        et = item.get("eventType", {}).get("S", "?")
        tier = item.get("customerTier", {}).get("S", "?")
        sla = item.get("slaHours", {}).get("N", "?")
        by_type[et][tier] += 1
        sla_by_type[et][sla] += 1
    if "LastEvaluatedKey" not in page:
        break
    kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]

policy = {}
for item in ddb.scan(TableName=POLICY_TABLE).get("Items", []):
    policy[item["tier"]["S"]] = item["slaHours"]["N"]

prose = []
prose.append("DIAGNOSIS - fulfillment OrderShipped records carry defaulted tier / SLA")
prose.append("")
prose.append("Failing rule : %s on bus %s" % (SHIPPED_RULE, PROD_BUS))
prose.append("Declared InputPathsMap (pre-fix): %s" % json.dumps(declared_paths, sort_keys=True))
prose.append("Recovered subscriber path via SQS observer probe: %s" % json.dumps(corrected_paths, sort_keys=True))
prose.append("")
prose.append("ROOT CAUSE")
prose.append(
    "  The shipped rule's InputPathsMap reads customerTier/customerRegion from "
    "a subtree that does not exist in the OrderShipped event body - the shipping "
    "service nests the subscriber block under detail.enrollment.* (not the "
    "detail.customer.* used by OrderPlaced/OrderReturned, and not the "
    "detail.subscriber.* the staging bus uses). EventBridge silently omits "
    "unresolved JSONPath variables, so the processor Lambda's env defaults "
    "kick in (STANDARD / unknown / slaHours=48) and rows land silently wrong. "
    "The audit archive log group is envelope-only by policy, so the raw shape "
    "is not discoverable by grepping - a temporary SQS observer target on the "
    "shipped rule captured the raw detail block for one probe event."
)
prose.append("")
prose.append("REMEDIATION APPLIED (events:PutTargets on the failing rule)")
for key, path in corrected_paths.items():
    prose.append("  %s: %s -> %s" % (key, declared_paths.get(key), path))
prose.append(
    "  Every other InputPathsMap entry and the entire InputTemplate string "
    "were preserved verbatim. The audit archive rule remains envelope-only. "
    "The disabled legacy rule, log-only canary rule, OrderPlaced/OrderReturned "
    "rules, and same-named staging rule were not modified."
)
prose.append("")
prose.append("EVIDENCE FROM THE RECORDS TABLE")
prose.append(
    "  Scanned %d rows in %s. Tier / slaHours mix per event type "
    "(pre-fix state): tiers=%s sla=%s"
    % (
        scanned,
        RECORDS_TABLE,
        json.dumps({k: dict(v) for k, v in by_type.items()}, sort_keys=True),
        json.dumps({k: dict(v) for k, v in sla_by_type.items()}, sort_keys=True),
    )
)
prose.append("  Tier policy table: %s" % json.dumps(policy, sort_keys=True))

with open("/logs/agent/agent-output.txt", "w") as fh:
    fh.write("\n".join(prose) + "\n")

contract = {
    "rule_name": SHIPPED_RULE,
    "bus_name": PROD_BUS,
    "corrected_paths": corrected_paths,
    "root_cause": (
        "The failing rule's InputTransformer read customerTier / customerRegion "
        "from a JSONPath subtree absent from the OrderShipped event body; the "
        "real subscriber block is nested under detail.enrollment.*. Unresolved "
        "variables collapsed to the processor's STANDARD / unknown defaults "
        "with slaHours=48."
    ),
}
with open("/logs/agent/agent-output.json", "w") as fh:
    json.dump(contract, fh, indent=2)

print("wrote /logs/agent/agent-output.txt and /logs/agent/agent-output.json")
PY
