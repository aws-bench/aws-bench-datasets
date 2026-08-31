"""Programmatic verifier for drain-sqs-backlog-with-governed-ceiling.

The agent must drain the order ingest SQS queue and keep it draining through
the platform reconciler's 5-minute cycle. Criteria are checked against
live AWS state; every one traces to the CDK (order-ingest-stack.ts,
platform-guardrail-stack.ts) or the pre_invoke degraded-baseline seed.

Verifier IAM actions required (all covered by QALocalInvocationApplicationAdmin):
  - lambda:ListEventSourceMappings
  - lambda:GetEventSourceMapping
  - lambda:GetFunctionConcurrency
  - lambda:GetFunction
  - ssm:GetParameter
  - events:DescribeRule
  - sqs:GetQueueAttributes
  - cloudwatch:DescribeAlarms
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1"))

ORDERS_QUEUE_URL = os.environ["ORDERS_QUEUE_URL"]
ORDERS_QUEUE_ARN = os.environ["ORDERS_QUEUE_ARN"]
ORDERS_QUEUE_NAME = os.environ["ORDERS_QUEUE_NAME"]
REPLAY_QUEUE_NAME = os.environ["REPLAY_QUEUE_NAME"]
PROCESSOR_FUNCTION_NAME = os.environ["PROCESSOR_FUNCTION_NAME"]
PROCESSOR_ALIAS_NAME = os.environ["PROCESSOR_ALIAS_NAME"]
EXPRESS_FUNCTION_NAME = os.environ["EXPRESS_FUNCTION_NAME"]
CEILINGS_PARAM_NAME = os.environ["CEILINGS_PARAM_NAME"]
GUARDRAIL_RULE_NAME = os.environ["GUARDRAIL_RULE_NAME"]
BACKLOG_DEPTH_ALARM_NAME = os.environ["BACKLOG_DEPTH_ALARM_NAME"]
INGEST_RULE_NAME = os.environ["INGEST_RULE_NAME"]
PROCESSOR_CONCURRENCY_ALARM_NAME = os.environ.get(
    "PROCESSOR_CONCURRENCY_ALARM_NAME", ""
)

# --- constants derived from CDK / pre_invoke ---------------------------------

# The minimum ceiling the agent must raise the sole Enabled mapping to.
# Deliberately a low bar: Little's Law on the arrival rate (~20 orders/min at
# ~18.5s processing) gives ~7 concurrent needed to keep pace, so 8 is a floor
# that proves the agent raised the ceiling meaningfully above the seeded
# degraded value. The true test that the fix works is `backlog_draining`,
# which asserts the queue is actually draining under live traffic.
REQUIRED_MAPPING_CEILING = 8

# CDK baseline redrive-lane mapping.
BASELINE_REDRIVE_MAX_CONCURRENCY = 4
BASELINE_REDRIVE_BATCH_SIZE = 10

# CDK baseline express-lane mapping.
BASELINE_EXPRESS_STATE = "Disabled"

# CDK baseline ingest rate rule state (should stay ENABLED).
BASELINE_INGEST_RULE_STATE = "ENABLED"

# CDK baseline processor concurrency utilisation alarm (should stay unchanged).
BASELINE_PROCESSOR_CONCURRENCY_ALARM_THRESHOLD = 90.0
BASELINE_PROCESSOR_CONCURRENCY_ALARM_EVAL_PERIODS = 3

# --- shared boto3 clients ----------------------------------------------------

_SESSION = boto3.Session(region_name=REGION)
_LAMBDA = _SESSION.client("lambda")
_SSM = _SESSION.client("ssm")
_EVENTS = _SESSION.client("events")
_SQS = _SESSION.client("sqs")
_CW = _SESSION.client("cloudwatch")


# --- helpers -----------------------------------------------------------------


def _account_id() -> str:
    sts = _SESSION.client("sts")
    return sts.get_caller_identity()["Account"]


def _processor_alias_arn() -> str:
    """`arn:aws:lambda:<region>:<account>:function:<processor>:<alias>`."""
    return f"arn:aws:lambda:{REGION}:{_account_id()}:function:{PROCESSOR_FUNCTION_NAME}:{PROCESSOR_ALIAS_NAME}"


def _orders_mappings() -> list[dict[str, Any]]:
    try:
        return _LAMBDA.list_event_source_mappings(EventSourceArn=ORDERS_QUEUE_ARN).get(
            "EventSourceMappings", []
        )
    except ClientError:
        return []


_TERMINAL_MAPPING_STATES = {"Enabled", "Disabled"}


def _wait_orders_mappings_stable(deadline_s: int = 60) -> None:
    """Poll orders-queue mappings until every one is in a terminal state.

    Prevents the verifier from evaluating baselines against a mapping that is
    still in `Updating` / `Enabling` / `Disabling` immediately after the
    agent's last mutation. Bounded to `deadline_s` seconds; if a mapping never
    settles, the caller proceeds with whatever list_event_source_mappings
    returns at that moment.
    """
    import time as _time

    deadline = _time.time() + deadline_s
    while _time.time() < deadline:
        maps = _orders_mappings()
        if maps and all(m.get("State") in _TERMINAL_MAPPING_STATES for m in maps):
            return
        _time.sleep(5)


def _enabled_orders_mapping_for_processor() -> dict[str, Any] | None:
    """Return the single Enabled mapping on the orders queue whose target is
    the processor alias; None if none or more than one such mapping exists.

    Filters strictly by the processor alias ARN so unrelated side consumers
    (e.g. the analytics tap) on the same queue never match.
    """
    alias_arn = _processor_alias_arn()
    candidates: list[dict[str, Any]] = []
    for m in _orders_mappings():
        if m.get("State") not in ("Enabled", "Enabling", "Updating"):
            continue
        function_arn = m.get("FunctionArn") or ""
        if function_arn == alias_arn:
            candidates.append(m)
    return candidates[0] if len(candidates) == 1 else None


def _mapping_ceiling(m: dict[str, Any]) -> int | None:
    return (m.get("ScalingConfig") or {}).get("MaximumConcurrency")


def _load_baseline_placeholders() -> dict[str, Any]:
    """Baseline snapshot from pre_invoke, delivered as an env var.

    Only ``tests/`` is bind-mounted here, so the placeholder file is unreadable.
    """
    data: dict[str, Any] = {}
    sha_env = os.environ.get("PROCESSOR_CODE_SHA256", "").strip()
    if sha_env:
        data["processor_code_sha256"] = sha_env
    return data


# --- criteria ---------------------------------------------------------------


@criterion(
    description="the sole Enabled orders-queue mapping targeting the processor alias now carries ScalingConfig.MaximumConcurrency >= 8 (a low bar; the true drain evidence is the backlog_draining criterion)"
)
def mapping_ceiling_raised(workspace: Path) -> bool:
    mapping = _enabled_orders_mapping_for_processor()
    if mapping is None:
        return False
    ceiling = _mapping_ceiling(mapping)
    if not isinstance(ceiling, int):
        return False
    return ceiling >= REQUIRED_MAPPING_CEILING


@criterion(
    description="processor's ReservedConcurrentExecutions permits the raised ceiling (>= 8 and >= the live mapping ceiling), or is unreserved"
)
def reserved_concurrency_permits_new_ceiling(workspace: Path) -> bool:
    mapping = _enabled_orders_mapping_for_processor()
    if mapping is None:
        return False
    live_ceiling = _mapping_ceiling(mapping)
    if not isinstance(live_ceiling, int):
        return False
    try:
        resp = _LAMBDA.get_function_concurrency(FunctionName=PROCESSOR_FUNCTION_NAME)
    except ClientError:
        return False
    reserved = resp.get("ReservedConcurrentExecutions")
    if reserved is None:
        return True
    try:
        # Floor at REQUIRED_MAPPING_CEILING as well as the live ceiling: the
        # seeded reserved value (4) already exceeds the seeded ceiling (3).
        return int(reserved) >= max(REQUIRED_MAPPING_CEILING, live_ceiling)
    except (TypeError, ValueError):
        return False


@criterion(
    description="governance change survives the reconciler: the SSM ceilings doc must have raised ceilings[<orders queue>] to >= 8 AND the guardrail EventBridge rule must remain ENABLED"
)
def governance_change_survives_reconciler(workspace: Path) -> bool:
    # Ceilings doc raised.
    try:
        raw = _SSM.get_parameter(Name=CEILINGS_PARAM_NAME)["Parameter"]["Value"]
        doc = json.loads(raw)
    except (ClientError, json.JSONDecodeError, ValueError, TypeError):
        return False
    ceilings = doc.get("ceilings") if isinstance(doc, dict) else None
    if not isinstance(ceilings, dict):
        return False
    entry = ceilings.get(ORDERS_QUEUE_NAME)
    if not isinstance(entry, (int, float)):
        return False
    if int(entry) < REQUIRED_MAPPING_CEILING:
        return False

    # Reconciler rule must remain ENABLED (disabling it is not a governed
    # remediation and is explicitly rejected).
    try:
        rule = _EVENTS.describe_rule(Name=GUARDRAIL_RULE_NAME)
    except ClientError:
        return False
    if rule.get("State") != "ENABLED":
        return False

    return True


@criterion(
    description="orders queue reached the drained terminal state (visible == 0 and none in flight) AND the backlog alarm is no longer in ALARM, within ~90s"
)
def backlog_draining(workspace: Path) -> bool:
    try:
        t0 = _SQS.get_queue_attributes(
            QueueUrl=ORDERS_QUEUE_URL,
            AttributeNames=[
                "ApproximateNumberOfMessages",
                "ApproximateNumberOfMessagesNotVisible",
            ],
        )["Attributes"]
        visible0 = int(t0.get("ApproximateNumberOfMessages", "0"))
        not_visible0 = int(t0.get("ApproximateNumberOfMessagesNotVisible", "0"))
    except (ClientError, ValueError, TypeError):
        return False

    def _alarm_ok() -> bool:
        try:
            resp = _CW.describe_alarms(AlarmNames=[BACKLOG_DEPTH_ALARM_NAME])
            state = (resp.get("MetricAlarms") or [{}])[0].get("StateValue")
            return state in ("OK", "INSUFFICIENT_DATA")
        except ClientError:
            return False

    if visible0 == 0 and not_visible0 == 0 and _alarm_ok():
        return True

    deadline = time.time() + 90
    while time.time() < deadline:
        time.sleep(15)
        try:
            t1 = _SQS.get_queue_attributes(
                QueueUrl=ORDERS_QUEUE_URL,
                AttributeNames=[
                    "ApproximateNumberOfMessages",
                    "ApproximateNumberOfMessagesNotVisible",
                ],
            )["Attributes"]
            visible1 = int(t1.get("ApproximateNumberOfMessages", "0"))
            not_visible1 = int(t1.get("ApproximateNumberOfMessagesNotVisible", "0"))
        except (ClientError, ValueError, TypeError):
            continue

        if visible1 == 0 and not_visible1 == 0 and _alarm_ok():
            return True

    return False


@criterion(
    description="blast radius contained: express mapping still Disabled, redrive mapping unchanged, processor CodeSha256 unchanged from pre_invoke baseline, ingest rate rule state unchanged, processor concurrency-utilisation alarm unchanged. NOTE: the analytics-tap mapping is deliberately NOT asserted here — it is a competing consumer on the same queue that silently steals orders, and disabling or removing it is a legitimate part of the remediation."
)
def blast_radius_contained(workspace: Path) -> bool:
    """Retry-wrapper over the actual state assertions.

    Lambda ESM transitions and CloudWatch alarm reads can each take up to a
    minute to become fully consistent after a burst of mutations. The
    underlying assertions are all baseline-vs-live comparisons; if any one is
    False on the first pass we wait for propagation and re-evaluate (up to 3
    attempts, ~90s total).
    """
    for attempt in range(3):
        if _blast_radius_check():
            return True
        if attempt < 2:
            import time as _time

            _time.sleep(30)
    return False


def _blast_radius_check() -> bool:
    # Wait for any mapping still in Updating/Enabling/Disabling to settle
    # before evaluating baselines.
    _wait_orders_mappings_stable()

    baseline = _load_baseline_placeholders()

    # 1. Express-lane mapping still Disabled and untouched.
    express_seen = 0
    express_ok = True
    for m in _orders_mappings():
        function_arn = m.get("FunctionArn") or ""
        if EXPRESS_FUNCTION_NAME and EXPRESS_FUNCTION_NAME in function_arn:
            express_seen += 1
            if m.get("State") != BASELINE_EXPRESS_STATE:
                express_ok = False
    if express_seen != 1 or not express_ok:
        return False

    # 2. Redrive-lane mapping unchanged.
    try:
        replay_arn = f"arn:aws:sqs:{REGION}:{_account_id()}:{REPLAY_QUEUE_NAME}"
        replay_mappings = _LAMBDA.list_event_source_mappings(
            EventSourceArn=replay_arn
        ).get("EventSourceMappings", [])
    except ClientError:
        return False
    if len(replay_mappings) != 1:
        return False
    replay_m = replay_mappings[0]
    if _mapping_ceiling(replay_m) != BASELINE_REDRIVE_MAX_CONCURRENCY:
        return False
    if replay_m.get("BatchSize") != BASELINE_REDRIVE_BATCH_SIZE:
        return False
    if replay_m.get("FunctionArn") != _processor_alias_arn():
        return False

    # 3. Analytics-tap: intentionally NOT checked. It is a competing consumer on
    #    the same queue, so disabling or deleting it is legitimate remediation.

    # 4. Processor code hash unchanged from pre_invoke baseline.
    baseline_sha = baseline.get("processor_code_sha256")
    if not (isinstance(baseline_sha, str) and baseline_sha):
        return False
    try:
        fn = _LAMBDA.get_function(FunctionName=PROCESSOR_FUNCTION_NAME)
    except ClientError:
        return False
    live_sha = fn.get("Configuration", {}).get("CodeSha256")
    if live_sha != baseline_sha:
        return False

    # 5. Ingest gateway rate rule state unchanged (still ENABLED).
    try:
        rule = _EVENTS.describe_rule(Name=INGEST_RULE_NAME)
    except ClientError:
        return False
    if rule.get("State") != BASELINE_INGEST_RULE_STATE:
        return False

    # 6. Processor concurrency-utilisation alarm untouched.
    if PROCESSOR_CONCURRENCY_ALARM_NAME:
        try:
            resp = _CW.describe_alarms(AlarmNames=[PROCESSOR_CONCURRENCY_ALARM_NAME])
        except ClientError:
            return False
        alarms = resp.get("MetricAlarms") or []
        if len(alarms) != 1:
            return False
        alarm = alarms[0]
        try:
            threshold = float(alarm.get("Threshold"))
        except (TypeError, ValueError):
            return False
        if threshold != BASELINE_PROCESSOR_CONCURRENCY_ALARM_THRESHOLD:
            return False
        if (
            alarm.get("EvaluationPeriods")
            != BASELINE_PROCESSOR_CONCURRENCY_ALARM_EVAL_PERIODS
        ):
            return False

    return True
