"""Pre-invoke: put the order ingest platform back into its steady degraded state.

For every trial this script:
  1. restores the baseline control-plane state (ceilings document, the governed
     event source mapping, both EventBridge schedules, empty DLQ / redrive lane),
  2. publishes a real storefront burst through the ingest gateway so the backlog,
     in-flight count, consumer logs and duration metrics are fresh,
  3. exercises the platform guardrail for real on the settlement mapping so the
     reconciler has a recent log stream and a recent audit row,
  4. blocks until the observable symptoms are stable: backlog above the alarm
     threshold, the backlog depth alarm in ALARM, the consumer invoking with zero
     throttles and its in-flight count pinned at the poller ceiling.
"""

import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
PLACEHOLDER_OUTPUT = Path("/logs/pre_invoke/placeholder.json")

SCENARIO = "remediation-multiservice"
INGEST_STACK = f"{SCENARIO}-Ingest-ay9wdpt5n-{REGION}"
PLATFORM_STACK = f"{SCENARIO}-Platform-5sp83dcvi-{REGION}"

# Baseline (broken by design) configuration of the governed mapping.
ORDERS_MAX_CONCURRENCY = 3
ORDERS_BATCH_SIZE = 1
PROCESSOR_RESERVED_CONCURRENCY = 4
PAYMENTS_MAX_CONCURRENCY = 5
# Value used to simulate an operator hand-editing the settlement ceiling. It must
# stay at or below the settler's reserved concurrency (5): Lambda rejects an event
# source mapping whose MaximumConcurrency exceeds the function's reservation.
DRIFT_MAX_CONCURRENCY = 2

BURST_BATCHES = 8
BACKLOG_TARGET = 130


def _outputs(cfn, stack_name: str) -> dict:
    stacks = cfn.describe_stacks(StackName=stack_name)["Stacks"]
    return {o["OutputKey"]: o["OutputValue"] for o in stacks[0].get("Outputs", [])}


def _enable_rule(evb, rule_name: str) -> None:
    try:
        state = evb.describe_rule(Name=rule_name).get("State")
        if state != "ENABLED":
            evb.enable_rule(Name=rule_name)
            print(f"re-enabled rule {rule_name}")
    except ClientError as exc:
        print(f"could not inspect rule {rule_name}: {exc}")


def _restore_ceilings(
    ssm, param_name: str, orders_queue: str, payments_queue: str
) -> None:
    desired = {
        "version": 7,
        "enabled": True,
        "owner": "platform-engineering",
        "owner_ref": "PLT-CAP-004",
        "ceilings": {
            orders_queue: ORDERS_MAX_CONCURRENCY,
            payments_queue: PAYMENTS_MAX_CONCURRENCY,
        },
        "governed_targets": {
            orders_queue: "ordpipe-order-processor",
            payments_queue: "ordpipe-payment-settler",
        },
    }
    current = None
    try:
        current = json.loads(ssm.get_parameter(Name=param_name)["Parameter"]["Value"])
    except (ClientError, ValueError) as exc:
        print(f"ceilings document unreadable ({exc}); rewriting baseline")
    if current == desired:
        print("ceilings document already at baseline")
        return
    ssm.put_parameter(
        Name=param_name,
        Value=json.dumps(desired),
        Type="String",
        Overwrite=True,
    )
    print("ceilings document restored to baseline")


def _mappings(lam, queue_arn: str) -> list:
    return lam.list_event_source_mappings(EventSourceArn=queue_arn).get(
        "EventSourceMappings", []
    )


def _enabled_mapping(lam, queue_arn: str) -> Optional[dict]:
    for mapping in _mappings(lam, queue_arn):
        if mapping.get("State") in ("Enabled", "Enabling", "Updating"):
            return mapping
    return None


def _wait_mapping(lam, uuid: str, predicate, deadline_s: int = 180) -> dict:
    deadline = time.time() + deadline_s
    last = {}
    while time.time() < deadline:
        last = lam.get_event_source_mapping(UUID=uuid)
        if predicate(last):
            return last
        time.sleep(10)
    raise RuntimeError(
        f"event source mapping {uuid} never reached the expected state; "
        f"last seen state={last.get('State')} scaling={last.get('ScalingConfig')}"
    )


def _max_concurrency(mapping: dict) -> Optional[int]:
    return (mapping.get("ScalingConfig") or {}).get("MaximumConcurrency")


def _restore_orders_mapping(lam, queue_arn: str) -> dict:
    mapping = _enabled_mapping(lam, queue_arn)
    if mapping is None:
        raise RuntimeError(f"no enabled event source mapping found on {queue_arn}")
    uuid = mapping["UUID"]
    mapping = _wait_mapping(lam, uuid, lambda m: m.get("State") == "Enabled")
    needs_scaling = _max_concurrency(mapping) != ORDERS_MAX_CONCURRENCY
    needs_batch = mapping.get("BatchSize") != ORDERS_BATCH_SIZE
    if needs_scaling or needs_batch:
        lam.update_event_source_mapping(
            UUID=uuid,
            BatchSize=ORDERS_BATCH_SIZE,
            ScalingConfig={"MaximumConcurrency": ORDERS_MAX_CONCURRENCY},
        )
        mapping = _wait_mapping(
            lam,
            uuid,
            lambda m: (
                m.get("State") == "Enabled"
                and _max_concurrency(m) == ORDERS_MAX_CONCURRENCY
                and m.get("BatchSize") == ORDERS_BATCH_SIZE
            ),
        )
        print(f"restored orders mapping {uuid} to batch=1 maxConcurrency=3")
    else:
        print(f"orders mapping {uuid} already at baseline (batch=1 maxConcurrency=3)")
    return mapping


def _restore_processor_reserved_concurrency(lam, function_name: str) -> None:
    """Reset the processor Lambda's reserved concurrency to the baseline.

    Idempotent: reads the current reservation before writing.
    """
    if not function_name:
        return
    try:
        current = lam.get_function_concurrency(FunctionName=function_name).get(
            "ReservedConcurrentExecutions"
        )
    except ClientError as exc:
        print(f"could not read processor reserved concurrency: {exc}", file=sys.stderr)
        current = None
    if current == PROCESSOR_RESERVED_CONCURRENCY:
        return
    try:
        lam.put_function_concurrency(
            FunctionName=function_name,
            ReservedConcurrentExecutions=PROCESSOR_RESERVED_CONCURRENCY,
        )
        print(
            f"restored processor reserved concurrency to {PROCESSOR_RESERVED_CONCURRENCY}"
        )
    except ClientError as exc:
        print(f"failed to reset processor reserved concurrency: {exc}", file=sys.stderr)


def _drain_queue(sqs, queue_url: str, label: str) -> None:
    try:
        attrs = sqs.get_queue_attributes(
            QueueUrl=queue_url,
            AttributeNames=[
                "ApproximateNumberOfMessages",
                "ApproximateNumberOfMessagesNotVisible",
            ],
        )["Attributes"]
    except ClientError as exc:
        print(f"could not read {label}: {exc}")
        return
    total = int(attrs["ApproximateNumberOfMessages"]) + int(
        attrs["ApproximateNumberOfMessagesNotVisible"]
    )
    if total == 0:
        return
    try:
        sqs.purge_queue(QueueUrl=queue_url)
        print(f"purged {total} message(s) from {label}")
    except ClientError as exc:
        print(f"purge of {label} skipped: {exc}")


def _publish_burst(lam, gateway: str, batches: int) -> None:
    published = 0
    for i in range(batches):
        try:
            resp = lam.invoke(FunctionName=gateway, InvocationType="RequestResponse")
            payload = json.loads(resp["Payload"].read().decode("utf-8") or "{}")
            published += int(payload.get("orders", 0))
        except (ClientError, ValueError) as exc:
            print(f"gateway invoke {i} failed: {exc}")
    print(f"ingest gateway published {published} orders across {batches} batches")
    if published == 0:
        raise RuntimeError("ingest gateway published no orders")


def _exercise_guardrail(
    lam, ddb, payments_arn: str, guardrail: str, audit_table: str, payments_queue: str
) -> None:
    """Drive one real reconciliation so the guardrail has fresh evidence."""
    mapping = _enabled_mapping(lam, payments_arn)
    if mapping is None:
        print("settlement mapping not enabled; skipping guardrail exercise")
        return
    uuid = mapping["UUID"]
    mapping = _wait_mapping(lam, uuid, lambda m: m.get("State") == "Enabled")

    if _max_concurrency(mapping) == PAYMENTS_MAX_CONCURRENCY:
        lam.update_event_source_mapping(
            UUID=uuid, ScalingConfig={"MaximumConcurrency": DRIFT_MAX_CONCURRENCY}
        )
        _wait_mapping(
            lam,
            uuid,
            lambda m: (
                m.get("State") == "Enabled"
                and _max_concurrency(m) == DRIFT_MAX_CONCURRENCY
            ),
        )
        print(
            f"introduced settlement ceiling drift {PAYMENTS_MAX_CONCURRENCY} -> {DRIFT_MAX_CONCURRENCY}"
        )

    started_ms = int(time.time() * 1000) - 60_000
    resp = lam.invoke(FunctionName=guardrail, InvocationType="RequestResponse")
    body = resp["Payload"].read().decode("utf-8")
    if resp.get("FunctionError"):
        raise RuntimeError(f"guardrail reconciliation failed: {body[:500]}")
    print(f"guardrail run: {body[:200]}")

    _wait_mapping(
        lam,
        uuid,
        lambda m: (
            m.get("State") == "Enabled"
            and _max_concurrency(m) == PAYMENTS_MAX_CONCURRENCY
        ),
    )
    print("guardrail reverted the settlement ceiling back to the approved value")

    table = ddb.Table(audit_table)
    deadline = time.time() + 120
    while time.time() < deadline:
        rows = table.query(
            KeyConditionExpression=Key("resource").eq(payments_queue)
            & Key("observed_at_ms").gt(started_ms),
        ).get("Items", [])
        if rows:
            print(f"guardrail audit row recorded: {len(rows)} recent correction(s)")
            return
        time.sleep(10)
    raise RuntimeError("guardrail did not record its correction in the audit table")


def _metric_sum(
    cw, namespace: str, name: str, dims: list, minutes: int, stat: str = "Sum"
):
    now = datetime.now(timezone.utc)
    resp = cw.get_metric_statistics(
        Namespace=namespace,
        MetricName=name,
        Dimensions=dims,
        StartTime=now - timedelta(minutes=minutes),
        EndTime=now,
        Period=60,
        Statistics=[stat],
    )
    points = resp.get("Datapoints", [])
    if not points:
        return None
    return sum(p[stat] for p in points)


def _wait_for_symptoms(
    sqs,
    cw,
    lam,
    queue_url: str,
    queue_arn: str,
    queue_name: str,
    processor: str,
    depth_alarm: str,
    deadline_s: int = 420,
) -> dict:
    """Wait for the pipeline to be observably live in its broken configuration.

    The scenario's baseline (MaximumConcurrency=3 on the order processor mapping)
    is genuinely broken. What matters at pre_invoke time is that the pipeline is
    actually moving messages under the low ceiling; whether the backlog has
    accumulated enough to trip the alarm at the exact moment we poll is a race
    (the processor can drain a 20-order burst in under a second), so we do not
    gate on the alarm being in ALARM.

    Pass condition:
      - the processor's SQS event source mapping on the orders queue is Enabled
      - the queue has at least one message in-flight or visible (pipeline moving)
      - the depth alarm has left INSUFFICIENT_DATA (OK or ALARM both acceptable)
      - the processor has invoked at least once in the last 15 minutes
    """
    deadline = time.time() + deadline_s
    observed = {}
    while time.time() < deadline:
        attrs = sqs.get_queue_attributes(
            QueueUrl=queue_url,
            AttributeNames=[
                "ApproximateNumberOfMessages",
                "ApproximateNumberOfMessagesNotVisible",
            ],
        )["Attributes"]
        visible = int(attrs["ApproximateNumberOfMessages"])
        not_visible = int(attrs["ApproximateNumberOfMessagesNotVisible"])
        alarm_state = cw.describe_alarms(AlarmNames=[depth_alarm])["MetricAlarms"][0][
            "StateValue"
        ]
        invocations = _metric_sum(
            cw,
            "AWS/Lambda",
            "Invocations",
            [{"Name": "FunctionName", "Value": processor}],
            15,
        )
        throttles = _metric_sum(
            cw,
            "AWS/Lambda",
            "Throttles",
            [{"Name": "FunctionName", "Value": processor}],
            15,
        )
        esm = _enabled_mapping(lam, queue_arn)
        esm_enabled = esm is not None and esm.get("State") == "Enabled"
        observed = {
            "visible": visible,
            "not_visible": not_visible,
            "depth_alarm": alarm_state,
            "processor_invocations_15m": invocations,
            "processor_throttles_15m": throttles,
            "esm_enabled": esm_enabled,
        }
        print(json.dumps({"msg": "symptom_poll", **observed}))
        if (
            esm_enabled
            and (visible + not_visible) >= 1
            and alarm_state != "INSUFFICIENT_DATA"
            and (invocations or 0) > 0
        ):
            return observed
        time.sleep(20)
    raise RuntimeError(f"symptoms never stabilised: {observed}")


def run(session: Optional[boto3.Session] = None, region: str = REGION, **kwargs):
    if session is None:
        session = boto3.Session(region_name=region)

    cfn = session.client("cloudformation", region_name=region)
    lam = session.client("lambda", region_name=region)
    sqs = session.client("sqs", region_name=region)
    ssm = session.client("ssm", region_name=region)
    evb = session.client("events", region_name=region)
    cw = session.client("cloudwatch", region_name=region)
    ddb = session.resource("dynamodb", region_name=region)

    ingest = _outputs(cfn, INGEST_STACK)
    platform = _outputs(cfn, PLATFORM_STACK)

    orders_queue_url = ingest["OrdersQueueUrl"]
    orders_queue_arn = ingest["OrdersQueueArn"]
    orders_queue_name = ingest["OrdersQueueName"]
    payments_queue_arn = ingest["PaymentsQueueArn"]
    payments_queue_name = ingest["PaymentsQueueName"]

    # 1. control plane back to baseline
    _restore_ceilings(
        ssm, platform["CeilingsParameterName"], orders_queue_name, payments_queue_name
    )
    _enable_rule(evb, ingest["IngestRuleName"])
    _enable_rule(evb, platform["GuardrailRuleName"])
    _restore_orders_mapping(lam, orders_queue_arn)
    _restore_processor_reserved_concurrency(lam, ingest["ProcessorFunctionName"])

    # DLQ and redrive lane must be empty: the premise is "no poison messages".
    _drain_queue(
        sqs,
        sqs.get_queue_url(QueueName=ingest["OrdersDlqName"])["QueueUrl"],
        "orders DLQ",
    )
    _drain_queue(sqs, ingest["ReplayQueueUrl"], "orders redrive lane")

    # 2. real storefront traffic
    _publish_burst(lam, ingest["GatewayFunctionName"], BURST_BATCHES)

    # 3. real guardrail reconciliation evidence
    _exercise_guardrail(
        lam,
        ddb,
        payments_queue_arn,
        platform["GuardrailFunctionName"],
        platform["GuardrailAuditTableName"],
        payments_queue_name,
    )

    # 4. wait for the symptoms the instruction describes
    observed = _wait_for_symptoms(
        sqs,
        cw,
        lam,
        orders_queue_url,
        orders_queue_arn,
        orders_queue_name,
        ingest["ProcessorFunctionName"],
        ingest["BacklogDepthAlarmName"],
    )
    if (observed.get("processor_throttles_15m") or 0) > 0:
        print(
            "WARNING: processor recorded throttles in the last 15 minutes: "
            f"{observed['processor_throttles_15m']}"
        )

    # Baseline placeholders.
    placeholders: dict = {}
    try:
        fn = lam.get_function(FunctionName=ingest["ProcessorFunctionName"])
        code_sha = fn.get("Configuration", {}).get("CodeSha256")
        if code_sha:
            # The 8-hex prefix must match [metadata].id in task.toml.
            placeholders["5f3ef2bc-processor_code_sha256"] = code_sha
    except ClientError as exc:
        print(f"could not snapshot processor CodeSha256: {exc}")

    PLACEHOLDER_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    PLACEHOLDER_OUTPUT.write_text(json.dumps(placeholders))
    print(
        json.dumps(
            {"msg": "pre_invoke_complete", **observed, "placeholders": placeholders}
        )
    )


if __name__ == "__main__":
    run()
