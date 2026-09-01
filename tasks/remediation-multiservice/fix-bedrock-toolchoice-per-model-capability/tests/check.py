"""Programmatic verifier for fix-bedrock-toolchoice-per-model-capability.

The agent must remediate the DocIntel extraction service so a fresh sweep
through the shared Bedrock Converse code path succeeds and the failure alarm
returns to OK. Two repair paths are accepted for the routing-profile criterion:

  A) mutate the three failing routing-profile rows in DynamoDB so the per-class
     acceptance policy is satisfied (baseline-succeeder rows must remain
     byte-identical), or
  B) deploy new router Lambda code (CodeSha256 diverged from the captured
     pre-invoke baseline) AND a fresh synchronous sweep returns SUCCEEDED for
     every enabled profile.

One additional criterion covers the second defect, which is separate from the
routing rows: the alarm cannot clear itself. The router publishes
ExtractionFailures only on failure and the alarm treats missing data as
retain-state, so a green sweep produces no datapoint and the alarm stays latched
in ALARM. ``alarm_stops_latching`` re-latches the alarm, drives a fresh green
sweep, and requires the alarm to leave ALARM without being told to.

Verifier IAM actions required (in addition to standard log/metric writes):
  - dynamodb:GetItem                     on the profiles table
  - lambda:GetFunction                   on the router Lambda (baseline check)
  - lambda:InvokeFunction                on the router Lambda
  - cloudwatch:DescribeAlarms            on the two alarms
  - cloudwatch:SetAlarmState             on the extraction-failure alarm
                                         (to latch it before testing self-clear)
The QALocalInvocationApplicationAdmin role grants all of these.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from decimal import Decimal
from pathlib import Path
from typing import Any

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_REGION", "us-east-1")
PROFILES_TABLE = os.environ["PROFILES_TABLE"]
FUNCTION_NAME = os.environ["FUNCTION_NAME"]
ALARM_NAME = os.environ["ALARM_NAME"]
INVOKE_ERROR_ALARM_NAME = os.environ["INVOKE_ERROR_ALARM_NAME"]

# Baseline routing configuration mirrors pre_invoke.py::PROFILE_BASELINE and
# scenarios/.../setup_bedrock_extraction_uyvjsf7fj.py::PROFILES. Any change to
# those files must be reflected here.
FAILING_PROFILES = ("receipts_v2", "invoices_v7", "statements_v3")
# Enabled baseline succeeders — every one of these rows must be byte-identical
# to baseline after remediation. Disabled decoys (receipts_v3, legacy_faxes_v1)
# are intentionally excluded here.
WORKING_PROFILES: dict[str, dict[str, Any]] = {
    "contracts_v4": {
        "modelId": "amazon.nova-pro-v1:0",
        "routingStrategy": "strict",
        "enabled": True,
    },
    "contracts_v5": {
        "modelId": "amazon.nova-pro-v1:0",
        "routingStrategy": "open",
        "enabled": True,
    },
    "purchase_orders_v2": {
        "modelId": "amazon.nova-lite-v1:0",
        "routingStrategy": "strict",
        "enabled": True,
    },
    "remittance_v1": {
        "modelId": "mistral.mistral-large-2402-v1:0",
        "routingStrategy": "open",
        "enabled": True,
    },
}

# Baseline (modelId, routingStrategy) for each failing profile — remediation
# must diverge from this pair.
FAILING_BASELINE: dict[str, tuple[str, str]] = {
    "receipts_v2": ("mistral.mistral-large-2402-v1:0", "strict"),
    "invoices_v7": ("us.meta.llama3-3-70b-instruct-v1:0", "strict"),
    "statements_v3": ("us.meta.llama3-3-70b-instruct-v1:0", "open"),
}

# Per-class acceptable routingStrategy replacements (schema-only fix path).
ACCEPTABLE_MODES: dict[str, tuple[str, ...]] = {
    "receipts_v2": ("open", "auto"),
    "invoices_v7": ("auto",),
    "statements_v3": ("auto",),
}

# Acceptable re-route target model families (prefix match — explicit, no
# generic substring). Nova / Claude / Amazon Titan support forced tool use.
FORCED_TOOL_MODEL_PREFIXES: tuple[str, ...] = (
    "amazon.nova-",
    "us.amazon.nova-",
    "anthropic.claude-",
    "us.anthropic.claude-",
    "eu.anthropic.claude-",
    "apac.anthropic.claude-",
    "amazon.titan-",
)

# --- Alarm self-clear timing ------------------------------------------------

# The alarm evaluates a 1-minute period, and CloudWatch takes up to ~90s to
# surface a just-published datapoint on a freshly-provisioned account. Poll for
# 300s so a genuine self-clear is never mistaken for a latch.
ALARM_POLL_ATTEMPTS = 10
ALARM_POLL_INTERVAL = 30  # seconds  (10 × 30s = 300s total wall time)


def _ddb_table():
    return boto3.resource("dynamodb", region_name=REGION).Table(PROFILES_TABLE)


def _get_profile(profile_id: str) -> dict[str, Any] | None:
    try:
        resp = _ddb_table().get_item(Key={"profileId": profile_id})
    except ClientError:
        return None
    return resp.get("Item")


def _coerce_enabled(val: Any) -> bool:
    if isinstance(val, bool):
        return val
    if isinstance(val, (Decimal, int, float)):
        return bool(val)
    return str(val).lower() == "true"


def _is_forced_tool_family(model_id: str) -> bool:
    return any(model_id.startswith(p) for p in FORCED_TOOL_MODEL_PREFIXES)


# --- Cached helpers ---------------------------------------------------------

_SWEEP_RESULT_CACHE: dict[str, bool] = {}


def _run_synchronous_sweep_all_green(force: bool = False) -> bool:
    """Invoke the router Lambda in sweep mode; True iff every enabled profile
    reports SUCCEEDED. Cached per verifier process so multiple criteria can
    share a single invocation.

    ``force`` skips the cache read, for a caller that needs the sweep's metric
    datapoints to land after a specific moment rather than just needing to know
    whether the sweep passes.
    """
    if not force and "result" in _SWEEP_RESULT_CACHE:
        return _SWEEP_RESULT_CACHE["result"]

    lam = boto3.client("lambda", region_name=REGION)
    label = f"verify-{uuid.uuid4().hex[:8]}"
    payload = {"mode": "sweep", "runLabel": label}

    # Bedrock DynamoDB reads and cross-region inference profiles can lag
    # briefly after a profile update. Bounded retry.
    result = False
    attempts = 0
    while attempts < 3:
        attempts += 1
        try:
            resp = lam.invoke(
                FunctionName=FUNCTION_NAME,
                InvocationType="RequestResponse",
                Payload=json.dumps(payload).encode("utf-8"),
            )
        except ClientError:
            time.sleep(10)
            continue
        if "FunctionError" in resp:
            time.sleep(10)
            continue
        try:
            body = json.loads(resp["Payload"].read().decode("utf-8"))
        except (json.JSONDecodeError, KeyError):
            break
        results = body.get("results") or []
        if not results:
            time.sleep(10)
            continue
        statuses = [r.get("status") for r in results]
        if all(s == "SUCCEEDED" for s in statuses):
            result = True
            break
        time.sleep(10)

    _SWEEP_RESULT_CACHE["result"] = result
    return result


def _read_baseline_router_sha() -> str | None:
    """The router Lambda's baseline CodeSha256, delivered as an env var.

    Only ``tests/`` is bind-mounted here, so the placeholder file is unreadable.
    """
    val = os.environ.get("ROUTER_LAMBDA_BASELINE_SHA", "").strip()
    return val or None


# Holds the last persistent GetFunction ClientError so callers can report it.
_GETFUNCTION_ERROR_MARKER: dict[str, str] = {}


def _current_router_code_sha() -> str | None:
    """Return CodeSha256 of the router Lambda, or None on failure.

    Bounded retry (3 attempts, exponential backoff starting at 2s) on any
    ClientError. On persistent failure the error message is printed to stdout
    (so it lands in the verifier output) and the last error is stashed in
    ``_GETFUNCTION_ERROR_MARKER`` so callers can surface it.
    """
    _GETFUNCTION_ERROR_MARKER.pop("last_error", None)
    lam = boto3.client("lambda", region_name=REGION)
    last_error: str | None = None
    for attempt in range(3):
        try:
            resp = lam.get_function(FunctionName=FUNCTION_NAME)
        except ClientError as exc:
            last_error = f"{type(exc).__name__}: {exc}"
            print(
                f"[check] _current_router_code_sha: attempt {attempt + 1}/3 "
                f"failed: {last_error}"
            )
            if attempt < 2:
                time.sleep(2 * (2**attempt))  # 2s, 4s
            continue
        sha = resp.get("Configuration", {}).get("CodeSha256")
        if isinstance(sha, str) and sha:
            return sha
        print(
            "[check] _current_router_code_sha: GetFunction returned no "
            "CodeSha256 in Configuration"
        )
        return None
    if last_error is not None:
        _GETFUNCTION_ERROR_MARKER["last_error"] = last_error
        print(
            f"[check] _current_router_code_sha: giving up after 3 attempts; "
            f"last error: {last_error}"
        )
    return None


def _all_failing_rows_repaired_via_ddb() -> bool:
    for pid in FAILING_PROFILES:
        item = _get_profile(pid)
        if item is None:
            return False
        model_id = item.get("modelId")
        strategy = item.get("routingStrategy")
        enabled = _coerce_enabled(item.get("enabled"))
        if not isinstance(model_id, str) or not isinstance(strategy, str):
            return False
        # Profile must still be enabled — disabling it would skip the class
        # entirely and pass by omission.
        if not enabled:
            return False

        baseline = FAILING_BASELINE[pid]
        # If the (modelId, routingStrategy) pair is exactly the baseline, the
        # DDB row has not been fixed.
        if (model_id, strategy) == baseline:
            return False

        strategy_ok = strategy in ACCEPTABLE_MODES[pid]
        route_ok = _is_forced_tool_family(model_id)
        if not (strategy_ok or route_ok):
            return False
    return True


def _router_code_fix_verified_once() -> tuple[
    bool, str | None, str | None, bool | None
]:
    """Single-shot Path B check. Returns
    ``(verified, baseline_or_None, current_or_error, sweep_result_or_None)``.

    ``current_or_error`` is the CodeSha256 string, or ``"GetFunction failed: <err>"``
    when the ClientError-retry path exhausted its budget, or ``None`` for any
    other failure to obtain a current sha.
    """
    baseline = _read_baseline_router_sha()
    if not baseline:
        return False, None, None, None
    current = _current_router_code_sha()
    if current is None:
        err = _GETFUNCTION_ERROR_MARKER.get("last_error")
        current_display = f"GetFunction failed: {err}" if err else None
        return False, baseline, current_display, None
    if current == baseline:
        return False, baseline, current, None
    sweep = _run_synchronous_sweep_all_green()
    return bool(sweep), baseline, current, sweep


def _router_code_fix_verified() -> bool:
    """The router Lambda has been redeployed (CodeSha256 changed from the
    captured pre-invoke baseline) AND a fresh sweep is green.

    Retries the full check once (2 attempts total, 3s sleep between) if the
    baseline or the current sha could not be obtained due to a transient
    error. Returns False on persistent failure.
    """
    verified, baseline, current, sweep = _router_code_fix_verified_once()
    # Transient: one of the two shas could not be collected — either the
    # baseline env var was empty or GetFunction exhausted its retry budget.
    transient = (
        (baseline is None)
        or (current is None)
        or (isinstance(current, str) and current.startswith("GetFunction failed:"))
    )
    if verified:
        return True
    if transient:
        print(
            "[check] _router_code_fix_verified: first attempt inconclusive "
            "(transient). Retrying Path B in 3s."
        )
        time.sleep(3)
        verified, baseline, current, sweep = _router_code_fix_verified_once()
        if verified:
            return True
    baseline_display = baseline if baseline else "MISSING"
    current_display = current if current else "MISSING"
    sweep_display = "None" if sweep is None else str(sweep)
    print(
        "[check] _router_code_fix_verified returning False: "
        f"baseline_sha={baseline_display}, current_sha={current_display}, "
        f"sweep_all_green={sweep_display}"
    )
    return False


@criterion(
    description="each failing profile is repaired — either the DDB row now satisfies the per-class acceptance policy, or the router Lambda code has diverged from the pre-invoke baseline AND a fresh sweep is green (generalised code-level fix)"
)
def failing_profiles_repaired(workspace: Path) -> bool:
    # Path A: schema-only fix — the three failing DDB rows now sit at an
    # accepted (modelId, routingStrategy) pair.
    if _all_failing_rows_repaired_via_ddb():
        return True
    # Path B: the router Lambda was redeployed and a fresh sweep is green.
    return _router_code_fix_verified()


@criterion(
    description="the enabled baseline succeeders (contracts_v4, contracts_v5, purchase_orders_v2, remittance_v1) retain baseline modelId/routingStrategy/enabled"
)
def working_profiles_untouched(workspace: Path) -> bool:
    for pid, baseline in WORKING_PROFILES.items():
        item = _get_profile(pid)
        if item is None:
            return False
        if item.get("modelId") != baseline["modelId"]:
            return False
        if item.get("routingStrategy") != baseline["routingStrategy"]:
            return False
        if _coerce_enabled(item.get("enabled")) != baseline["enabled"]:
            return False
    return True


@criterion(
    description="a fresh synchronous sweep through the router Lambda returns SUCCEEDED for every enabled profile"
)
def sweep_now_green(workspace: Path) -> bool:
    return _run_synchronous_sweep_all_green()


@criterion(
    description="the extraction-failure alarm leaves ALARM by itself after a fresh green sweep, so the same workload no longer latches it (either the router publishes an explicit 0 on success, or the alarm no longer treats missing data as retain-state)"
)
def alarm_stops_latching(workspace: Path) -> bool:
    """Latch the alarm, drive a fresh green sweep, wait for it to clear itself.

    The alarm sums ExtractionFailures over one minute at threshold 1 with
    treatMissingData=missing. A sweep that publishes no failure datapoint leaves
    the state untouched, so an account whose profile rows are repaired and
    nothing else keeps the alarm in ALARM and fails here. Two fixes clear it: the
    router publishing an explicit 0-valued ExtractionFailures on every success,
    or the alarm treating missing data as not-breaching.

    The latch is driven here so the starting state is identical whether or not
    the agent already pushed the alarm to OK, and the sweep is forced past the
    per-process cache so its datapoints land after the latch.
    """
    cw = boto3.client("cloudwatch", region_name=REGION)
    try:
        cw.set_alarm_state(
            AlarmName=ALARM_NAME,
            StateValue="ALARM",
            StateReason="verifier: latch before testing whether the alarm self-clears",
        )
    except ClientError:
        return False

    if not _run_synchronous_sweep_all_green(force=True):
        return False

    for _ in range(ALARM_POLL_ATTEMPTS):
        time.sleep(ALARM_POLL_INTERVAL)
        try:
            alarms = cw.describe_alarms(AlarmNames=[ALARM_NAME]).get("MetricAlarms", [])
        except ClientError:
            continue
        if alarms and alarms[0].get("StateValue", "ALARM") != "ALARM":
            return True
    return False


@criterion(
    description="router invocation-error alarm is not in ALARM (guards against fixing extractions by faulting the Lambda)"
)
def invoke_error_alarm_stays_ok(workspace: Path) -> bool:
    cw = boto3.client("cloudwatch", region_name=REGION)
    try:
        alarms = cw.describe_alarms(AlarmNames=[INVOKE_ERROR_ALARM_NAME]).get(
            "MetricAlarms", []
        )
    except ClientError:
        return False
    if not alarms:
        return False
    return alarms[0].get("StateValue") in ("OK", "INSUFFICIENT_DATA")
