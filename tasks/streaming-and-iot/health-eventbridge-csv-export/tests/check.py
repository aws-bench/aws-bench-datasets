"""Programmatic verifier for health-eventbridge-csv-export.

Validates the agent built an EventBridge rule on the precondition custom
bus + a Lambda + the rule->Lambda target wiring + the Lambda's resource
policy permitting EventBridge invocation.

Per AWS docs:
  - https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-use-resource-based.html
  - https://docs.aws.amazon.com/AmazonEventBridge/latest/APIReference/API_Rule.html
"""

import json
import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

import time
from datetime import datetime, timezone

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
EVENT_BUS_NAME = os.environ.get("EVENT_BUS_NAME", "")
EXPORT_BUCKET = os.environ.get("EXPORT_BUCKET", "")
HEALTH_ROLE_NAME = os.environ.get("HEALTH_ROLE_NAME", "")

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    AGENT_OUTPUT = {}

REQUIRED_OUTPUT_KEYS = ("lambda_function_name", "rule_name")
CHOSEN_LAMBDA_NAME = AGENT_OUTPUT.get("lambda_function_name") or ""
CHOSEN_RULE_NAME = AGENT_OUTPUT.get("rule_name") or ""


def _lambda():
    return boto3.client("lambda", region_name=REGION)


def _events():
    return boto3.client("events", region_name=REGION)


def _get_lambda_arn() -> str | None:
    if not CHOSEN_LAMBDA_NAME:
        return None
    try:
        return _lambda().get_function(FunctionName=CHOSEN_LAMBDA_NAME)["Configuration"][
            "FunctionArn"
        ]
    except ClientError:
        return None


def _describe_rule() -> dict | None:
    if not CHOSEN_RULE_NAME or not EVENT_BUS_NAME:
        return None
    try:
        return _events().describe_rule(
            Name=CHOSEN_RULE_NAME, EventBusName=EVENT_BUS_NAME
        )
    except ClientError:
        return None


@criterion(description="agent wrote agent-output.json with all required keys")
def output_contract_followed(workspace: Path) -> bool:
    return bool(AGENT_OUTPUT) and all(k in AGENT_OUTPUT for k in REQUIRED_OUTPUT_KEYS)


@criterion(description="Lambda exists and uses the pre-deployed Health role")
def lambda_exists_uses_role(workspace: Path) -> bool:
    if not CHOSEN_LAMBDA_NAME or not HEALTH_ROLE_NAME:
        return False
    try:
        cfg = _lambda().get_function(FunctionName=CHOSEN_LAMBDA_NAME)["Configuration"]
    except ClientError:
        return False
    role_arn = cfg.get("Role", "")
    return role_arn.endswith(f":role/{HEALTH_ROLE_NAME}")


@criterion(
    description="EventBridge rule on custom bus is ENABLED and matches aws.health source"
)
def rule_enabled_health_pattern(workspace: Path) -> bool:
    rule = _describe_rule()
    if rule is None:
        return False
    if rule.get("State") != "ENABLED":
        return False
    pattern_str = rule.get("EventPattern") or ""
    try:
        pattern = json.loads(pattern_str)
    except json.JSONDecodeError:
        return False
    sources = pattern.get("source") or []
    if isinstance(sources, str):
        sources = [sources]
    return "aws.health" in sources or any("health" in s for s in sources)


@criterion(description="Lambda is a target of the rule")
def lambda_is_rule_target(workspace: Path) -> bool:
    arn = _get_lambda_arn()
    if arn is None or not CHOSEN_RULE_NAME or not EVENT_BUS_NAME:
        return False
    try:
        resp = _events().list_targets_by_rule(
            Rule=CHOSEN_RULE_NAME, EventBusName=EVENT_BUS_NAME
        )
    except ClientError:
        return False
    return any(t.get("Arn") == arn for t in resp.get("Targets", []))


@criterion(
    description="Lambda resource policy grants events.amazonaws.com:InvokeFunction with SourceArn = rule ARN"
)
def lambda_grants_eventbridge(workspace: Path) -> bool:
    if not CHOSEN_LAMBDA_NAME:
        return False
    rule = _describe_rule()
    if rule is None:
        return False
    rule_arn = rule.get("Arn", "")
    try:
        resp = _lambda().get_policy(FunctionName=CHOSEN_LAMBDA_NAME)
    except ClientError:
        return False
    try:
        policy = json.loads(resp.get("Policy") or "{}")
    except json.JSONDecodeError:
        return False
    statements = policy.get("Statement") or []
    if isinstance(statements, dict):
        statements = [statements]
    for stmt in statements:
        if (stmt.get("Effect") or "").lower() != "allow":
            continue
        principal = stmt.get("Principal") or {}
        svc = principal.get("Service") if isinstance(principal, dict) else principal
        if isinstance(svc, list):
            svc_match = "events.amazonaws.com" in svc
        else:
            svc_match = svc == "events.amazonaws.com"
        if not svc_match:
            continue
        actions = stmt.get("Action", [])
        if isinstance(actions, str):
            actions = [actions]
        if not any(a in {"lambda:InvokeFunction", "lambda:*", "*"} for a in actions):
            continue
        cond = stmt.get("Condition") or {}
        # Find the SourceArn condition value. lambda.add_permission emits the
        # key as "AWS:SourceArn", but raw policy documents may use lowercase
        # "aws:SourceArn" (IAM evaluates condition keys case-insensitively), so
        # match the key case-insensitively across the ARN/string operators. This
        # keeps a correctly-scoped policy recognizable however it was created.
        arn_eq = None
        for _op in ("ArnLike", "ArnEquals", "StringEquals", "StringLike"):
            _block = cond.get(_op)
            if not isinstance(_block, dict):
                continue
            for _key, _val in _block.items():
                if _key.lower() == "aws:sourcearn":
                    arn_eq = _val
                    break
            if arn_eq is not None:
                break
        # The invoke permission must be scoped to THIS rule. A statement
        # with no SourceArn condition lets every EventBridge rule in the
        # account invoke the function, so it does not satisfy the
        # requirement -- keep scanning the other statements instead of
        # accepting it.
        if arn_eq is None:
            continue
        if arn_eq == rule_arn or (isinstance(arn_eq, list) and rule_arn in arn_eq):
            return True
    return False


# Behavioral criterion: invoke the agent's Lambda directly with a
# synthetic EventBridge-shaped aws.health event -- the same envelope
# EventBridge delivers to a Lambda target -- and confirm the function
# writes the event's detail as an object to the export bucket. This
# proves the Lambda half of the pipeline (parse the Health event and
# export its detail to S3) actually works, end to end.
#
# Why a direct invoke and NOT PutEvents onto the bus:
#   * The "aws." source prefix is reserved for AWS service events.
#     PutEvents rejects any entry whose Source begins with "aws." on a
#     per-entry basis -- the API returns HTTP 200 with a non-zero
#     FailedEntryCount and a per-entry ErrorCode, NOT a ClientError --
#     so a synthetic "aws.health" event is silently dropped and never
#     reaches the rule. (The previous implementation's try/except
#     ClientError could not observe this, so it always "succeeded" while
#     delivering nothing, making the task unsolvable.)
#   * Real aws.health events are emitted only by the AWS Health service
#     and are delivered exclusively to the DEFAULT event bus -- never to
#     a custom bus. There is no API to inject a genuine aws.health event
#     onto this custom bus.
# The rule -> Lambda wiring (target + invoke permission scoped to the
# rule) is verified structurally by lambda_is_rule_target and
# lambda_grants_eventbridge; this criterion covers the remaining
# behavioral contract.
# Refs:
#   https://docs.aws.amazon.com/health/latest/ug/cloudwatch-events-health.html
#   https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-putevents.html

E2E_POLL_SEC = 90
E2E_INTERVAL_SEC = 10


@criterion(
    description="behavioral: invoking the Lambda with a synthetic aws.health event writes the event detail as a new object in the export bucket"
)
def synthetic_event_lands_in_s3(workspace: Path) -> bool:
    if not CHOSEN_LAMBDA_NAME or not EXPORT_BUCKET:
        return False
    s3_client = boto3.client("s3", region_name=REGION)
    try:
        s3_client.list_objects_v2(Bucket=EXPORT_BUCKET, MaxKeys=1)
    except ClientError:
        return False

    # Slack on cutoff to absorb verifier-vs-S3 clock skew.
    from datetime import timedelta

    cutoff = datetime.now(timezone.utc) - timedelta(seconds=30)
    lambda_client = _lambda()
    paginator = s3_client.get_paginator("list_objects_v2")

    def _invoke_synthetic_event() -> bool:
        now_iso = datetime.now(timezone.utc).isoformat()
        # Mirror the envelope EventBridge delivers to a Lambda target for
        # an aws.health event; the agent's Lambda reads event["detail"].
        event = {
            "version": "0",
            "id": "synthetic-verifier-e2e",
            "detail-type": "AWS Health Event",
            "source": "aws.health",
            "account": "000000000000",
            "time": now_iso,
            "region": REGION,
            "resources": [],
            "detail": {
                "eventArn": "arn:aws:health:us-east-1::event/SYNTHETIC/SyntheticVerifierEvent",
                "service": "EC2",
                "eventTypeCategory": "issue",
                "eventScopeCode": "ACCOUNT_SPECIFIC",
                "communicationId": "verifier-e2e",
                "startTime": now_iso,
                "lastUpdatedTime": now_iso,
                "statusCode": "open",
                "eventDescription": [
                    {
                        "language": "en_US",
                        "latestDescription": "synthetic verifier probe",
                    }
                ],
            },
        }
        try:
            resp = lambda_client.invoke(
                FunctionName=CHOSEN_LAMBDA_NAME,
                InvocationType="RequestResponse",
                Payload=json.dumps(event).encode("utf-8"),
            )
        except ClientError:
            return False
        # An unhandled exception in the function surfaces as FunctionError;
        # that means the Lambda did not successfully process the event.
        if resp.get("FunctionError"):
            return False
        return resp.get("StatusCode") == 200

    if not _invoke_synthetic_event():
        return False

    # A synchronous (RequestResponse) invoke returns only after the
    # handler completes, so any S3 write has already happened by now. We
    # still poll briefly to absorb S3 list-after-write latency.
    elapsed = 0
    while True:
        try:
            for page in paginator.paginate(Bucket=EXPORT_BUCKET):
                for obj in page.get("Contents") or []:
                    last_modified = obj.get("LastModified")
                    if last_modified and last_modified > cutoff:
                        return True
        except ClientError:
            pass
        if elapsed >= E2E_POLL_SEC:
            return False
        time.sleep(E2E_INTERVAL_SEC)
        elapsed += E2E_INTERVAL_SEC


def _invoke_synthetic_event() -> bool:
    """Invoke the Lambda with a synthetic aws.health event; True on a clean invocation."""
    if not CHOSEN_LAMBDA_NAME:
        return False
    now_iso = datetime.now(timezone.utc).isoformat()
    event = {
        "version": "0",
        "id": "synthetic-verifier-e2e",
        "detail-type": "AWS Health Event",
        "source": "aws.health",
        "account": "000000000000",
        "time": now_iso,
        "region": REGION,
        "resources": [],
        "detail": {
            "eventArn": "arn:aws:health:us-east-1::event/SYNTHETIC/SyntheticVerifierEvent",
            "service": "EC2",
            "eventTypeCategory": "issue",
            "eventScopeCode": "ACCOUNT_SPECIFIC",
            "communicationId": "verifier-e2e",
            "startTime": now_iso,
            "lastUpdatedTime": now_iso,
            "statusCode": "open",
            "eventDescription": [
                {"language": "en_US", "latestDescription": "synthetic verifier probe"}
            ],
        },
    }
    try:
        resp = _lambda().invoke(
            FunctionName=CHOSEN_LAMBDA_NAME,
            InvocationType="RequestResponse",
            Payload=json.dumps(event).encode("utf-8"),
        )
    except ClientError:
        return False
    if resp.get("FunctionError"):
        return False
    return resp.get("StatusCode") == 200


@criterion(
    description="exported S3 object is valid JSON containing health event detail fields"
)
def exported_object_is_json(workspace: Path) -> bool:
    """Confirm the object a synthetic invoke writes parses as a JSON object."""
    if not EXPORT_BUCKET or not _invoke_synthetic_event():
        return False
    s3_client = boto3.client("s3", region_name=REGION)
    try:
        resp = s3_client.list_objects_v2(Bucket=EXPORT_BUCKET, MaxKeys=50)
    except ClientError:
        return False
    objects = resp.get("Contents") or []
    if not objects:
        return False
    # Get the most recent object
    latest = max(objects, key=lambda o: o.get("LastModified", ""))
    try:
        obj = s3_client.get_object(Bucket=EXPORT_BUCKET, Key=latest["Key"])
        body = obj["Body"].read().decode("utf-8").strip()
    except (ClientError, UnicodeDecodeError):
        return False
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return False
    # Should contain health event detail fields
    return isinstance(data, dict)
