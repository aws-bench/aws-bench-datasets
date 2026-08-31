"""Platform concurrency guardrail.

Reconciles the SQS poller scaling ceilings of every managed consumer against the
ceilings document held in SSM. The platform team owns the document; application
teams own their event source mappings, so any mapping whose
ScalingConfig.MaximumConcurrency drifts away from the approved ceiling is put
back and the correction is recorded in the guardrail audit table.

Invoked on a fixed schedule by EventBridge. A run that finds no drift writes
nothing.
"""

import json
import os
import time

import boto3

ssm = boto3.client("ssm")
lam = boto3.client("lambda")
ddb = boto3.resource("dynamodb")

CEILINGS_PARAM = os.environ["CEILINGS_PARAM"]
AUDIT_TABLE = os.environ["AUDIT_TABLE"]

_audit = ddb.Table(AUDIT_TABLE)


def _account_from_context(context) -> str:
    # arn:aws:lambda:<region>:<account>:function:<name>
    return context.invoked_function_arn.split(":")[4]


def _ceilings_document() -> dict:
    raw = ssm.get_parameter(Name=CEILINGS_PARAM)["Parameter"]["Value"]
    return json.loads(raw)


def _record(item: dict) -> None:
    _audit.put_item(Item=item)


def handler(event, context):
    region = os.environ.get("AWS_REGION", "us-east-1")
    account = _account_from_context(context)

    doc = _ceilings_document()
    if not doc.get("enabled", True):
        print(
            json.dumps({"msg": "policy_disabled", "policy_version": doc.get("version")})
        )
        return {"enabled": False, "corrections": 0}

    ceilings = doc.get("ceilings") or {}
    governed_targets = doc.get("governed_targets") or {}
    policy_version = doc.get("version", 0)

    inspected = 0
    corrections = []
    for queue_name, desired_raw in ceilings.items():
        desired = int(desired_raw)
        target_hint = governed_targets.get(queue_name)
        queue_arn = f"arn:aws:sqs:{region}:{account}:{queue_name}"
        mappings = lam.list_event_source_mappings(EventSourceArn=queue_arn).get(
            "EventSourceMappings", []
        )
        for mapping in mappings:
            # Only live mappings are governed: staged mappings that have not been
            # enabled yet are the owning team's business.
            if mapping.get("State") != "Enabled":
                continue
            # Only mappings targeting the governed function for this queue.
            # Other side consumers (analytics taps, replay lanes) are out of
            # scope for the capacity policy.
            if target_hint:
                fn_arn = mapping.get("FunctionArn") or ""
                fn_part = fn_arn.split(":function:")[-1]
                fn_name = fn_part.split(":")[0]
                if fn_name != target_hint:
                    continue
            inspected += 1
            current = (mapping.get("ScalingConfig") or {}).get("MaximumConcurrency")
            if current == desired:
                continue
            uuid = mapping["UUID"]
            lam.update_event_source_mapping(
                UUID=uuid, ScalingConfig={"MaximumConcurrency": desired}
            )
            now_ms = int(time.time() * 1000)
            entry = {
                "resource": queue_name,
                "observed_at_ms": now_ms,
                "action": "REVERTED_DRIFT",
                "mapping_uuid": uuid,
                "target": mapping.get("FunctionArn", "unknown").split(":function:")[-1],
                "previous_max_concurrency": int(current) if current is not None else -1,
                "enforced_max_concurrency": desired,
                "policy_version": int(policy_version),
                "policy_parameter": CEILINGS_PARAM,
                "actor": os.environ.get("AWS_LAMBDA_FUNCTION_NAME", "guardrail"),
            }
            _record(entry)
            corrections.append(entry)
            print(
                json.dumps(
                    {
                        "msg": "reverted_scaling_config_drift",
                        "queue": queue_name,
                        "mapping_uuid": uuid,
                        "from": current,
                        "to": desired,
                        "policy_parameter": CEILINGS_PARAM,
                    }
                )
            )

    print(
        json.dumps(
            {
                "msg": "guardrail_run_complete",
                "policy_version": policy_version,
                "mappings_inspected": inspected,
                "corrections": len(corrections),
            }
        )
    )
    return {"mappings_inspected": inspected, "corrections": len(corrections)}
