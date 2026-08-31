"""Post-invoke reset for drain-sqs-backlog-with-governed-ceiling.

Restores the order ingest scenario to its intentionally-broken baseline. The
ceilings document, the processor's reserved concurrency, and the orders,
analytics-tap, redrive and express event source mappings all return to the
values declared below. The guardrail and ingest rules are re-enabled, and the
orders queue and its dead-letter queue are purged. The processor's code is
restored from published Version 1 when its CodeSha256 has drifted from the
baseline recorded in SSM.

Baseline values mirror the CDK stacks under
scenarios/remediation-multiservice/scenario/cdk_app/candidates/sqs-lambda/stacks/.

Best-effort: the whole body is wrapped in try/except so partial failures never raise.
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
import urllib.request
from typing import Any, Optional

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_DEFAULT_REGION", os.environ.get("AWS_REGION", "us-east-1"))

ORDERS_QUEUE_URL = os.environ.get("ORDERS_QUEUE_URL", "")
ORDERS_QUEUE_ARN = os.environ.get("ORDERS_QUEUE_ARN", "")
ORDERS_QUEUE_NAME = os.environ.get("ORDERS_QUEUE_NAME", "")
ORDERS_DLQ_NAME = os.environ.get("ORDERS_DLQ_NAME", "")
PAYMENTS_QUEUE_NAME = os.environ.get("PAYMENTS_QUEUE_NAME", "")
PROCESSOR_FUNCTION_NAME = os.environ.get("PROCESSOR_FUNCTION_NAME", "")
PROCESSOR_ALIAS_NAME = os.environ.get("PROCESSOR_ALIAS_NAME", "live")
CEILINGS_PARAM_NAME = os.environ.get("CEILINGS_PARAM_NAME", "")
GUARDRAIL_RULE_NAME = os.environ.get("GUARDRAIL_RULE_NAME", "")
INGEST_RULE_NAME = os.environ.get("INGEST_RULE_NAME", "")
REPLAY_QUEUE_NAME = os.environ.get("REPLAY_QUEUE_NAME", "")
EXPRESS_FUNCTION_NAME = os.environ.get("EXPRESS_FUNCTION_NAME", "")
ANALYTICS_TAP_FUNCTION_NAME = os.environ.get("ANALYTICS_TAP_FUNCTION_NAME", "")
ANALYTICS_TAP_ALIAS_NAME = os.environ.get("ANALYTICS_TAP_ALIAS_NAME", "live")

# Baseline SHA seeded at scenario setup time. Optional.
PROCESSOR_BASELINE_SHA_PARAM = "/platform/ingest/processor-baseline-sha"

# Baseline (broken by design) values - mirror platform-guardrail-stack.ts /
# order-ingest-stack.ts / pre_invoke.py.
ORDERS_MAX_CONCURRENCY = 3
ORDERS_BATCH_SIZE = 1
PAYMENTS_MAX_CONCURRENCY = 5
PROCESSOR_RESERVED_CONCURRENCY = 4

# Side-mapping CDK baselines - mirror
# candidates/sqs-lambda/stacks/order-ingest-stack.ts.
ANALYTICS_TAP_MAX_CONCURRENCY = 10
ANALYTICS_TAP_BATCH_SIZE = 5
REDRIVE_MAX_CONCURRENCY = 4
REDRIVE_BATCH_SIZE = 10


def _mapping_ceiling(m: dict[str, Any]) -> Optional[int]:
    return (m.get("ScalingConfig") or {}).get("MaximumConcurrency")


def _wait_mapping(lam, uuid_: str, predicate, deadline_s: int = 180) -> dict[str, Any]:
    deadline = time.time() + deadline_s
    last: dict[str, Any] = {}
    while time.time() < deadline:
        try:
            last = lam.get_event_source_mapping(UUID=uuid_)
        except ClientError:
            time.sleep(5)
            continue
        if predicate(last):
            return last
        time.sleep(5)
    return last


def _reset_ceilings(ssm) -> None:
    if not CEILINGS_PARAM_NAME or not ORDERS_QUEUE_NAME or not PAYMENTS_QUEUE_NAME:
        print(
            "CEILINGS_PARAM_NAME / ORDERS_QUEUE_NAME / PAYMENTS_QUEUE_NAME not set; "
            "skipping ceilings reset",
            file=sys.stderr,
        )
        return
    desired = {
        "version": 7,
        "enabled": True,
        "owner": "platform-engineering",
        "owner_ref": "PLT-CAP-004",
        "ceilings": {
            ORDERS_QUEUE_NAME: ORDERS_MAX_CONCURRENCY,
            PAYMENTS_QUEUE_NAME: PAYMENTS_MAX_CONCURRENCY,
        },
        "governed_targets": {
            ORDERS_QUEUE_NAME: "ordpipe-order-processor",
            PAYMENTS_QUEUE_NAME: "ordpipe-payment-settler",
        },
    }
    current: Any = None
    try:
        current = json.loads(
            ssm.get_parameter(Name=CEILINGS_PARAM_NAME)["Parameter"]["Value"]
        )
    except (ClientError, ValueError) as exc:
        print(f"ceilings doc unreadable ({exc}); rewriting baseline", file=sys.stderr)
    if current == desired:
        print("ceilings document already at baseline")
        return
    try:
        ssm.put_parameter(
            Name=CEILINGS_PARAM_NAME,
            Value=json.dumps(desired),
            Type="String",
            Overwrite=True,
        )
        print("ceilings document restored to baseline")
    except ClientError as exc:
        print(f"failed to reset ceilings doc: {exc}", file=sys.stderr)


def _reset_processor_reserved_concurrency(lam) -> None:
    if not PROCESSOR_FUNCTION_NAME:
        return
    try:
        current = lam.get_function_concurrency(
            FunctionName=PROCESSOR_FUNCTION_NAME
        ).get("ReservedConcurrentExecutions")
    except ClientError as exc:
        print(f"could not read processor reserved concurrency: {exc}", file=sys.stderr)
        current = None
    if current == PROCESSOR_RESERVED_CONCURRENCY:
        print(
            f"processor reserved concurrency already at {PROCESSOR_RESERVED_CONCURRENCY}"
        )
        return
    try:
        lam.put_function_concurrency(
            FunctionName=PROCESSOR_FUNCTION_NAME,
            ReservedConcurrentExecutions=PROCESSOR_RESERVED_CONCURRENCY,
        )
        print(
            f"processor reserved concurrency restored to {PROCESSOR_RESERVED_CONCURRENCY}"
        )
    except ClientError as exc:
        print(f"failed to reset processor reserved concurrency: {exc}", file=sys.stderr)


def _reset_orders_mapping(lam) -> None:
    if not ORDERS_QUEUE_ARN:
        return
    try:
        mappings = lam.list_event_source_mappings(EventSourceArn=ORDERS_QUEUE_ARN).get(
            "EventSourceMappings", []
        )
    except ClientError as exc:
        print(f"could not list orders queue mappings: {exc}", file=sys.stderr)
        return
    # Find the sole Enabled mapping targeting the processor alias.
    target_uuid: Optional[str] = None
    for m in mappings:
        state = m.get("State")
        if state not in ("Enabled", "Enabling", "Updating", "Disabled", "Disabling"):
            continue
        fn_arn = m.get("FunctionArn") or ""
        if PROCESSOR_FUNCTION_NAME and fn_arn.endswith(
            f":function:{PROCESSOR_FUNCTION_NAME}:{PROCESSOR_ALIAS_NAME}"
        ):
            # Only the live-alias one is the governed mapping. The redrive
            # mapping also targets the alias but on a different queue, so
            # filtering on EventSourceArn=ORDERS_QUEUE_ARN already excluded it.
            target_uuid = m["UUID"]
            break
    if target_uuid is None:
        print(
            "no orders queue mapping targeting processor alias; skipping mapping reset"
        )
        return

    # Wait for the mapping to leave transitional states before updating.
    m = _wait_mapping(
        lam, target_uuid, lambda x: x.get("State") in ("Enabled", "Disabled")
    )
    needs_ceiling = _mapping_ceiling(m) != ORDERS_MAX_CONCURRENCY
    needs_batch = m.get("BatchSize") != ORDERS_BATCH_SIZE
    needs_enable = m.get("State") != "Enabled"
    if not (needs_ceiling or needs_batch or needs_enable):
        print(f"orders mapping {target_uuid} already at baseline")
        return
    try:
        kwargs: dict[str, Any] = {
            "UUID": target_uuid,
            "BatchSize": ORDERS_BATCH_SIZE,
            "ScalingConfig": {"MaximumConcurrency": ORDERS_MAX_CONCURRENCY},
        }
        if needs_enable:
            kwargs["Enabled"] = True
        lam.update_event_source_mapping(**kwargs)
    except ClientError as exc:
        print(f"failed to update orders mapping {target_uuid}: {exc}", file=sys.stderr)
        return
    _wait_mapping(
        lam,
        target_uuid,
        lambda x: (
            x.get("State") == "Enabled"
            and _mapping_ceiling(x) == ORDERS_MAX_CONCURRENCY
            and x.get("BatchSize") == ORDERS_BATCH_SIZE
        ),
    )
    print(f"orders mapping {target_uuid} reset to batch=1 maxConcurrency=3")


def _reset_analytics_tap_mapping(lam) -> None:
    """Restore the analytics-tap event source mapping on the orders queue.

    CDK baseline: State=Enabled, BatchSize=5, ScalingConfig.MaximumConcurrency=10,
    targeting the analytics-tap ``live`` alias.
    """
    if not ORDERS_QUEUE_ARN or not ANALYTICS_TAP_FUNCTION_NAME:
        return
    try:
        mappings = lam.list_event_source_mappings(EventSourceArn=ORDERS_QUEUE_ARN).get(
            "EventSourceMappings", []
        )
    except ClientError as exc:
        print(
            f"could not list orders queue mappings for analytics-tap: {exc}",
            file=sys.stderr,
        )
        return
    target_uuid: Optional[str] = None
    for m in mappings:
        fn_arn = m.get("FunctionArn") or ""
        # Match either alias-bound or bare function ARN.
        if fn_arn.endswith(
            f":function:{ANALYTICS_TAP_FUNCTION_NAME}:{ANALYTICS_TAP_ALIAS_NAME}"
        ) or fn_arn.endswith(f":function:{ANALYTICS_TAP_FUNCTION_NAME}"):
            target_uuid = m["UUID"]
            break
    if target_uuid is None:
        print("no analytics-tap mapping found; skipping analytics-tap reset")
        return
    m = _wait_mapping(
        lam, target_uuid, lambda x: x.get("State") in ("Enabled", "Disabled")
    )
    needs_ceiling = _mapping_ceiling(m) != ANALYTICS_TAP_MAX_CONCURRENCY
    needs_batch = m.get("BatchSize") != ANALYTICS_TAP_BATCH_SIZE
    needs_enable = m.get("State") != "Enabled"
    if not (needs_ceiling or needs_batch or needs_enable):
        print(f"analytics-tap mapping {target_uuid} already at baseline")
        return
    try:
        kwargs: dict[str, Any] = {
            "UUID": target_uuid,
            "BatchSize": ANALYTICS_TAP_BATCH_SIZE,
            "ScalingConfig": {"MaximumConcurrency": ANALYTICS_TAP_MAX_CONCURRENCY},
        }
        if needs_enable:
            kwargs["Enabled"] = True
        lam.update_event_source_mapping(**kwargs)
    except ClientError as exc:
        print(
            f"failed to update analytics-tap mapping {target_uuid}: {exc}",
            file=sys.stderr,
        )
        return
    _wait_mapping(
        lam,
        target_uuid,
        lambda x: (
            x.get("State") == "Enabled"
            and _mapping_ceiling(x) == ANALYTICS_TAP_MAX_CONCURRENCY
            and x.get("BatchSize") == ANALYTICS_TAP_BATCH_SIZE
        ),
    )
    print(
        f"analytics-tap mapping {target_uuid} reset to "
        f"batch={ANALYTICS_TAP_BATCH_SIZE} maxConcurrency={ANALYTICS_TAP_MAX_CONCURRENCY}"
    )


def _reset_replay_mapping(lam, sts) -> None:
    """Restore the redrive-lane mapping on the replay queue.

    CDK baseline: State=Enabled, BatchSize=10, ScalingConfig.MaximumConcurrency=4,
    targeting the processor ``live`` alias.
    """
    if not REPLAY_QUEUE_NAME or not PROCESSOR_FUNCTION_NAME:
        return
    try:
        account_id = sts.get_caller_identity()["Account"]
    except ClientError as exc:
        print(
            f"could not resolve caller identity for redrive reset: {exc}",
            file=sys.stderr,
        )
        return
    replay_arn = f"arn:aws:sqs:{REGION}:{account_id}:{REPLAY_QUEUE_NAME}"
    try:
        mappings = lam.list_event_source_mappings(EventSourceArn=replay_arn).get(
            "EventSourceMappings", []
        )
    except ClientError as exc:
        print(f"could not list redrive queue mappings: {exc}", file=sys.stderr)
        return
    target_uuid: Optional[str] = None
    for m in mappings:
        fn_arn = m.get("FunctionArn") or ""
        if fn_arn.endswith(
            f":function:{PROCESSOR_FUNCTION_NAME}:{PROCESSOR_ALIAS_NAME}"
        ):
            target_uuid = m["UUID"]
            break
    if target_uuid is None:
        print("no redrive mapping targeting processor alias; skipping redrive reset")
        return
    m = _wait_mapping(
        lam, target_uuid, lambda x: x.get("State") in ("Enabled", "Disabled")
    )
    needs_ceiling = _mapping_ceiling(m) != REDRIVE_MAX_CONCURRENCY
    needs_batch = m.get("BatchSize") != REDRIVE_BATCH_SIZE
    needs_enable = m.get("State") != "Enabled"
    if not (needs_ceiling or needs_batch or needs_enable):
        print(f"redrive mapping {target_uuid} already at baseline")
        return
    try:
        kwargs: dict[str, Any] = {
            "UUID": target_uuid,
            "BatchSize": REDRIVE_BATCH_SIZE,
            "ScalingConfig": {"MaximumConcurrency": REDRIVE_MAX_CONCURRENCY},
        }
        if needs_enable:
            kwargs["Enabled"] = True
        lam.update_event_source_mapping(**kwargs)
    except ClientError as exc:
        print(f"failed to update redrive mapping {target_uuid}: {exc}", file=sys.stderr)
        return
    _wait_mapping(
        lam,
        target_uuid,
        lambda x: (
            x.get("State") == "Enabled"
            and _mapping_ceiling(x) == REDRIVE_MAX_CONCURRENCY
            and x.get("BatchSize") == REDRIVE_BATCH_SIZE
        ),
    )
    print(
        f"redrive mapping {target_uuid} reset to "
        f"batch={REDRIVE_BATCH_SIZE} maxConcurrency={REDRIVE_MAX_CONCURRENCY}"
    )


def _reset_express_mapping(lam) -> None:
    """Restore the express-lane mapping to State=Disabled.

    CDK ships it ``enabled: false`` on the orders queue.
    """
    if not ORDERS_QUEUE_ARN or not EXPRESS_FUNCTION_NAME:
        return
    try:
        mappings = lam.list_event_source_mappings(EventSourceArn=ORDERS_QUEUE_ARN).get(
            "EventSourceMappings", []
        )
    except ClientError as exc:
        print(
            f"could not list orders queue mappings for express reset: {exc}",
            file=sys.stderr,
        )
        return
    target_uuid: Optional[str] = None
    for m in mappings:
        fn_arn = m.get("FunctionArn") or ""
        # Express targets the bare function (no alias). Match on the function
        # name suffix so we don't confuse it with the analytics tap.
        if EXPRESS_FUNCTION_NAME in fn_arn and fn_arn.endswith(
            f":function:{EXPRESS_FUNCTION_NAME}"
        ):
            target_uuid = m["UUID"]
            break
    if target_uuid is None:
        print("no express-lane mapping found; skipping express reset")
        return
    m = _wait_mapping(
        lam, target_uuid, lambda x: x.get("State") in ("Enabled", "Disabled")
    )
    if m.get("State") == "Disabled":
        print(f"express mapping {target_uuid} already Disabled")
        return
    try:
        lam.update_event_source_mapping(UUID=target_uuid, Enabled=False)
    except ClientError as exc:
        print(
            f"failed to disable express mapping {target_uuid}: {exc}", file=sys.stderr
        )
        return
    _wait_mapping(lam, target_uuid, lambda x: x.get("State") == "Disabled")
    print(f"express mapping {target_uuid} reset to State=Disabled")


def _restore_processor_code(lam, ssm) -> None:
    """Restore processor Lambda code if the agent mutated it.

    Reads a baseline SHA from SSM ``/platform/ingest/processor-baseline-sha``
    (optional; if setup did not seed it, this is a no-op). When the live
    CodeSha256 differs, attempts to restore code from published Version 1
    (which the CDK-published alias was originally bound to) via a signed-URL
    download and ``UpdateFunctionCode(ZipFile=...)``. All failure paths are
    logged and swallowed.
    """
    if not PROCESSOR_FUNCTION_NAME:
        return
    try:
        baseline_sha = ssm.get_parameter(Name=PROCESSOR_BASELINE_SHA_PARAM)[
            "Parameter"
        ]["Value"].strip()
    except ClientError:
        # Setup did not seed the baseline; nothing to compare against.
        print(
            f"processor baseline sha not in SSM ({PROCESSOR_BASELINE_SHA_PARAM}); "
            "skipping code drift check",
            file=sys.stderr,
        )
        return
    if not baseline_sha:
        return
    try:
        fn = lam.get_function(FunctionName=PROCESSOR_FUNCTION_NAME)
        live_sha = (fn.get("Configuration") or {}).get("CodeSha256")
    except ClientError as exc:
        print(f"could not read processor code sha: {exc}", file=sys.stderr)
        return
    if live_sha == baseline_sha:
        return
    print(
        f"processor code drifted (live={live_sha} baseline={baseline_sha}); "
        "attempting restore from published Version 1",
        file=sys.stderr,
    )
    try:
        v1 = lam.get_function(FunctionName=PROCESSOR_FUNCTION_NAME, Qualifier="1")
    except ClientError as exc:
        print(
            f"processor Version 1 unavailable ({exc}); leaving tainted code in place",
            file=sys.stderr,
        )
        return
    code_url = (v1.get("Code") or {}).get("Location")
    if not code_url:
        print(
            "Version 1 code URL not available; leaving tainted code in place",
            file=sys.stderr,
        )
        return
    try:
        with urllib.request.urlopen(code_url, timeout=30) as resp:  # noqa: S310 - AWS-signed URL
            zip_bytes = resp.read()
    except (OSError, ValueError) as exc:
        print(f"could not download processor Version 1 zip: {exc}", file=sys.stderr)
        return
    try:
        lam.update_function_code(
            FunctionName=PROCESSOR_FUNCTION_NAME, ZipFile=zip_bytes
        )
    except ClientError as exc:
        print(f"update_function_code failed: {exc}", file=sys.stderr)
        return
    print(f"restored processor code to Version 1 (baseline sha={baseline_sha})")


def _purge_orders_queue(sqs) -> None:
    if not ORDERS_QUEUE_URL and not ORDERS_QUEUE_NAME:
        return
    queue_url = ORDERS_QUEUE_URL
    if not queue_url:
        try:
            queue_url = sqs.get_queue_url(QueueName=ORDERS_QUEUE_NAME)["QueueUrl"]
        except ClientError as exc:
            print(f"get_queue_url {ORDERS_QUEUE_NAME}: {exc}", file=sys.stderr)
            return
    try:
        sqs.purge_queue(QueueUrl=queue_url)
        print(f"purged orders queue {ORDERS_QUEUE_NAME or queue_url}")
    except ClientError as exc:
        # PurgeQueueInProgress throttles at once per 60s and is not fatal.
        print(f"purge_queue orders queue skipped: {exc}", file=sys.stderr)


def _enable_rule(evb, rule_name: str, label: str) -> None:
    if not rule_name:
        return
    try:
        state = evb.describe_rule(Name=rule_name).get("State")
    except ClientError as exc:
        print(f"could not describe {label} rule {rule_name}: {exc}", file=sys.stderr)
        return
    if state == "ENABLED":
        print(f"{label} rule {rule_name} already ENABLED")
        return
    try:
        evb.enable_rule(Name=rule_name)
        print(f"re-enabled {label} rule {rule_name}")
    except ClientError as exc:
        print(f"failed to enable {label} rule {rule_name}: {exc}", file=sys.stderr)


def _purge_dlq(sqs) -> None:
    if not ORDERS_DLQ_NAME:
        return
    try:
        queue_url = sqs.get_queue_url(QueueName=ORDERS_DLQ_NAME)["QueueUrl"]
    except ClientError as exc:
        print(f"get_queue_url {ORDERS_DLQ_NAME}: {exc}", file=sys.stderr)
        return
    try:
        sqs.purge_queue(QueueUrl=queue_url)
        print(f"purged DLQ {ORDERS_DLQ_NAME}")
    except ClientError as exc:
        # PurgeQueueInProgress throttles at once per 60s and is not fatal.
        print(f"purge_queue {ORDERS_DLQ_NAME} skipped: {exc}", file=sys.stderr)


def main() -> int:
    try:
        session = boto3.Session(region_name=REGION)
        ssm = session.client("ssm", region_name=REGION)
        lam = session.client("lambda", region_name=REGION)
        evb = session.client("events", region_name=REGION)
        sqs = session.client("sqs", region_name=REGION)
        sts = session.client("sts", region_name=REGION)

        _reset_ceilings(ssm)
        _reset_processor_reserved_concurrency(lam)
        _reset_orders_mapping(lam)
        _reset_analytics_tap_mapping(lam)
        _reset_replay_mapping(lam, sts)
        _reset_express_mapping(lam)
        _restore_processor_code(lam, ssm)
        _enable_rule(evb, GUARDRAIL_RULE_NAME, "guardrail")
        _enable_rule(evb, INGEST_RULE_NAME, "ingest")
        _purge_dlq(sqs)
        _purge_orders_queue(sqs)
    except Exception:
        # Never raise: record the traceback and return 0.
        print("post_invoke encountered a non-fatal error:", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
