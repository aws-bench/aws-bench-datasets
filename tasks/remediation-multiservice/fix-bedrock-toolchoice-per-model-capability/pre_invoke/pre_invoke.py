"""Pre-invoke: drive real traffic through the DocIntel extraction service.

Every trial starts from the same observable state:

1. the routing profiles are reset to the deployed baseline,
2. the run ledger is emptied,
3. a full sweep is executed synchronously (real bedrock:Converse calls),
4. three documents are dropped into ``incoming/`` so the S3-notification path
   produces a second minute of failure datapoints,
5. we block until the run ledger, the CloudWatch log group and the
   structured-output alarm all reflect the expected state.

The alarm uses ``treatMissingData: missing`` so once it latches into ALARM it
stays there for the whole trial, independent of when the agent looks.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, Optional

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
STACK_NAME = "remediation-multiservice-Bedrock-uyvjsf7fj-us-east-1"
PLACEHOLDER_OUTPUT = Path("/logs/pre_invoke/placeholder.json")

# Stable S3 keys holding the router-Lambda baseline captured at setup time.
# Must mirror the setup script and this task's post_invoke.
ROUTER_BASELINE_ZIP_KEY = "_baseline/router.zip"
ROUTER_BASELINE_MANIFEST_KEY = "_baseline/manifest.json"

# Baseline routing configuration (the deployed production state).
PROFILE_BASELINE: Dict[str, Dict[str, Any]] = {
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
    "invoices_v7": {
        "modelId": "us.meta.llama3-3-70b-instruct-v1:0",
        "routingStrategy": "strict",
        "enabled": True,
    },
    "purchase_orders_v2": {
        "modelId": "amazon.nova-lite-v1:0",
        "routingStrategy": "strict",
        "enabled": True,
    },
    "receipts_v2": {
        "modelId": "mistral.mistral-large-2402-v1:0",
        "routingStrategy": "strict",
        "enabled": True,
    },
    "receipts_v3": {
        "modelId": "mistral.mistral-large-2402-v1:0",
        "routingStrategy": "strict",
        "enabled": False,
    },
    "remittance_v1": {
        "modelId": "mistral.mistral-large-2402-v1:0",
        "routingStrategy": "open",
        "enabled": True,
    },
    "statements_v3": {
        "modelId": "us.meta.llama3-3-70b-instruct-v1:0",
        "routingStrategy": "open",
        "enabled": True,
    },
    "legacy_faxes_v1": {
        "modelId": "us.deepseek.r1-v1:0",
        "routingStrategy": "auto",
        "enabled": False,
    },
}

EXPECTED_FAILURES = {"invoices_v7", "receipts_v2", "statements_v3"}
EXPECTED_SUCCESSES = {
    "contracts_v4",
    "contracts_v5",
    "purchase_orders_v2",
    "remittance_v1",
}

INCOMING_DOCS: Dict[str, str] = {
    "incoming/invoices_v7/2025-03-batch-0447.txt": """VERTEX INDUSTRIAL SUPPLY CO.
INVOICE

Invoice No:      INV-2025-0088577
Invoice Date:    2025-03-18
Customer:        Northwind Logistics Group Ltd.
PO Reference:    PO-44301-A
Currency:        EUR

  1. Hydraulic hose assembly 3/4in     12 x  74.10  =   889.20
  2. Quick-coupler set                  6 x 121.00  =   726.00

Subtotal    1615.20
VAT 21%      339.19
TOTAL DUE   1954.39
""",
    "incoming/receipts_v2/2025-03-batch-0448.txt": """HOTEL DE ZWAAN
Prinsengracht 512, Amsterdam
Folio 90142

Date: 2025-03-17
  Room charge 1 night        168.00
  City tax                    12.60
  Breakfast                   19.50

TOTAL EUR                    200.10
Paid by card MASTERCARD **** 8802
Expense category: Lodging
Employee: R. Castellanos (emp 20881)
""",
    "incoming/statements_v3/2025-03-batch-0449.txt": """MERIDIAN COMMERCIAL BANK
Business Current Account Statement

Account holder:   Northwind Logistics Group Ltd.
Account number:   ****6642
Currency:         EUR
Statement period: 2025-03-01 to 2025-03-31

Opening balance                                90,957.82
  2025-03-05  Incoming ACH Halberd Retail      41,880.00
  2025-03-12  Payroll run 2025-03             -95,204.11
  2025-03-24  Supplier payment run            -18,440.72
Closing balance                                19,192.99
""",
}


def _stack_outputs(session: boto3.Session, region: str) -> Dict[str, str]:
    cfn = session.client("cloudformation", region_name=region)
    stack = cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]
    return {o["OutputKey"]: o["OutputValue"] for o in stack.get("Outputs", [])}


def _load_baseline_manifest(
    session: boto3.Session, region: str, bucket: str
) -> Optional[Dict[str, Any]]:
    """Fetch the router-Lambda baseline manifest written at scenario-setup
    time. Returns None (with a stderr note) when unavailable so callers can
    skip the restore leg and rely on inline PROFILE_BASELINE.
    """
    s3 = session.client("s3", region_name=region)
    try:
        obj = s3.get_object(Bucket=bucket, Key=ROUTER_BASELINE_MANIFEST_KEY)
        manifest = json.loads(obj["Body"].read().decode("utf-8"))
    except (ClientError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        print(
            f"router baseline manifest unavailable at s3://{bucket}/"
            f"{ROUTER_BASELINE_MANIFEST_KEY}: {exc}"
        )
        return None
    if not isinstance(manifest, dict):
        return None
    return manifest


def _wait_for_update(lam: Any, function_name: str) -> None:
    try:
        waiter = lam.get_waiter("function_updated")
        waiter.wait(
            FunctionName=function_name, WaiterConfig={"Delay": 3, "MaxAttempts": 30}
        )
    except Exception as exc:  # noqa: BLE001
        print(f"warning: function_updated waiter did not complete: {exc}")


def _restore_router_lambda(
    session: boto3.Session,
    region: str,
    function_name: str,
    bucket: str,
    manifest: Optional[Dict[str, Any]],
) -> str:
    """Restore the router Lambda's code and env vars to the setup-time baseline
    if either has drifted.

    Returns the router Lambda's CodeSha256 after the restore attempt so the
    caller can persist it as the trial's expected baseline. If no restore is
    performed (manifest unavailable), simply returns the current sha.
    """
    lam = session.client("lambda", region_name=region)

    try:
        cfg = lam.get_function_configuration(FunctionName=function_name)
    except ClientError as exc:
        print(f"failed to describe router {function_name}: {exc}")
        return ""

    current_sha = cfg.get("CodeSha256", "") or ""
    current_env = (cfg.get("Environment", {}) or {}).get("Variables", {}) or {}

    if manifest is None:
        return current_sha

    baseline_sha = manifest.get("codeSha256", "") or ""
    baseline_env = manifest.get("environment", {}) or {}
    baseline_zip_key = manifest.get("codeS3Key") or ROUTER_BASELINE_ZIP_KEY
    baseline_zip_bucket = manifest.get("codeS3Bucket") or bucket

    if baseline_sha and current_sha != baseline_sha:
        s3 = session.client("s3", region_name=region)
        try:
            zip_obj = s3.get_object(Bucket=baseline_zip_bucket, Key=baseline_zip_key)
            zip_bytes = zip_obj["Body"].read()
            lam.update_function_code(
                FunctionName=function_name, ZipFile=zip_bytes, Publish=False
            )
            _wait_for_update(lam, function_name)
            print(
                f"restored router {function_name} code {current_sha!r} -> baseline {baseline_sha!r}"
            )
            # Re-read after update so the returned sha reflects reality.
            cfg = lam.get_function_configuration(FunctionName=function_name)
            current_sha = cfg.get("CodeSha256", "") or ""
        except ClientError as exc:
            print(f"failed to restore router code: {exc}")

    if isinstance(baseline_env, dict) and current_env != baseline_env:
        try:
            lam.update_function_configuration(
                FunctionName=function_name,
                Environment={"Variables": dict(baseline_env)},
            )
            _wait_for_update(lam, function_name)
            print(
                f"restored router {function_name} env vars to baseline ({len(baseline_env)} keys)"
            )
        except ClientError as exc:
            print(f"failed to restore router env vars: {exc}")

    return current_sha


def _reset_profiles_from_manifest(
    session: boto3.Session,
    region: str,
    table_name: str,
    manifest: Optional[Dict[str, Any]],
) -> bool:
    """Re-seed every profile row from the S3 manifest (full record fidelity —
    including toolSchema, promptPreamble, etc.). Returns True if the manifest
    path was taken; False means the caller should fall back to the inline
    PROFILE_BASELINE subset reset.
    """
    if not manifest:
        return False
    rows = manifest.get("profiles")
    if not isinstance(rows, list):
        return False
    manifest_rows = [
        dict(r) for r in rows if isinstance(r, dict) and r.get("profileId")
    ]
    if not manifest_rows:
        return False

    table = session.resource("dynamodb", region_name=region).Table(table_name)
    updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    try:
        with table.batch_writer() as batch:
            for row in manifest_rows:
                item = dict(row)
                item["updatedAt"] = updated_at
                batch.put_item(Item=item)
    except ClientError as exc:
        print(f"failed full profile restore from manifest: {exc}")
        return False
    print(
        f"restored {len(manifest_rows)} full profile rows from manifest into {table_name}"
    )
    return True


def _reset_profiles(session: boto3.Session, region: str, table_name: str) -> None:
    table = session.resource("dynamodb", region_name=region).Table(table_name)
    for profile_id, baseline in PROFILE_BASELINE.items():
        try:
            table.update_item(
                Key={"profileId": profile_id},
                UpdateExpression="SET modelId = :m, routingStrategy = :c, enabled = :e",
                ConditionExpression="attribute_exists(profileId)",
                ExpressionAttributeValues={
                    ":m": baseline["modelId"],
                    ":c": baseline["routingStrategy"],
                    ":e": baseline["enabled"],
                },
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            raise RuntimeError(
                f"profile {profile_id} missing from {table_name}; deploy setup script did not run"
            ) from exc
    print(f"reset {len(PROFILE_BASELINE)} routing profiles in {table_name}")


def _clear_runs(session: boto3.Session, region: str, table_name: str) -> None:
    table = session.resource("dynamodb", region_name=region).Table(table_name)
    deleted = 0
    kwargs: Dict[str, Any] = {"ProjectionExpression": "profileId, runId"}
    while True:
        page = table.scan(**kwargs)
        items = page.get("Items", [])
        if items:
            with table.batch_writer() as batch:
                for item in items:
                    batch.delete_item(
                        Key={"profileId": item["profileId"], "runId": item["runId"]}
                    )
                    deleted += 1
        if "LastEvaluatedKey" not in page:
            break
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    print(f"cleared {deleted} stale run rows from {table_name}")


def _scan_runs(session: boto3.Session, region: str, table_name: str) -> list:
    table = session.resource("dynamodb", region_name=region).Table(table_name)
    items: list = []
    kwargs: Dict[str, Any] = {}
    while True:
        page = table.scan(**kwargs)
        items.extend(page.get("Items", []))
        if "LastEvaluatedKey" not in page:
            break
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    return items


def _sweep(
    session: boto3.Session,
    region: str,
    function_name: str,
    label: str,
    profile_ids=None,
) -> Dict[str, str]:
    lam = session.client("lambda", region_name=region)
    payload: Dict[str, Any] = {"mode": "sweep", "runLabel": label}
    if profile_ids:
        payload["profileIds"] = sorted(profile_ids)
    resp = lam.invoke(
        FunctionName=function_name,
        InvocationType="RequestResponse",
        Payload=json.dumps(payload).encode("utf-8"),
    )
    body = json.loads(resp["Payload"].read().decode("utf-8"))
    if "FunctionError" in resp:
        raise RuntimeError(f"router Lambda faulted: {body}")
    outcome = {r["profileId"]: r["status"] for r in body.get("results", [])}
    print(f"sweep '{label}' -> {json.dumps(outcome, sort_keys=True)}")
    return outcome


def _wait_for_alarm(
    session: boto3.Session, region: str, alarm_name: str, want: str, timeout: int = 420
) -> None:
    cw = session.client("cloudwatch", region_name=region)
    deadline = time.time() + timeout
    state = "UNKNOWN"
    while time.time() < deadline:
        alarms = cw.describe_alarms(AlarmNames=[alarm_name])["MetricAlarms"]
        if alarms:
            state = alarms[0]["StateValue"]
            if state == want:
                print(f"alarm {alarm_name} is {state}")
                return
        time.sleep(20)
    raise RuntimeError(f"alarm {alarm_name} did not reach {want} (last state {state})")


def _wait_for_logs(
    session: boto3.Session, region: str, log_group: str, needle: str, timeout: int = 240
) -> None:
    logs = session.client("logs", region_name=region)
    start = int((time.time() - 3600) * 1000)
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            resp = logs.filter_log_events(
                logGroupName=log_group,
                startTime=start,
                filterPattern=f'"{needle}"',
                limit=5,
            )
            if resp.get("events"):
                print(
                    f"log group {log_group} exposes {len(resp['events'])}+ {needle} events"
                )
                return
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ResourceNotFoundException":
                raise
        time.sleep(15)
    raise RuntimeError(f"log group {log_group} never surfaced a {needle} event")


def run(session: Optional[boto3.Session] = None, region: str = REGION, **kwargs):
    if session is None:
        session = boto3.Session(region_name=region)

    outputs = _stack_outputs(session, region)
    function_name = outputs["FunctionName"]
    profiles_table = outputs["ProfilesTableName"]
    runs_table = outputs["RunsTableName"]
    bucket = outputs["DocumentsBucketName"]
    alarm_name = outputs["AlarmName"]
    log_group = outputs["LogGroupName"]

    # Restore the router Lambda before any observation: the baseline captured
    # below must not be a prior trial's mutated code.
    manifest = _load_baseline_manifest(session, region, bucket)
    _restore_router_lambda(session, region, function_name, bucket, manifest)

    # Full profile-row restore from manifest when available; otherwise fall
    # back to the inline PROFILE_BASELINE model/routing subset.
    if not _reset_profiles_from_manifest(session, region, profiles_table, manifest):
        _reset_profiles(session, region, profiles_table)
    _clear_runs(session, region, runs_table)

    # Real production sweep across every enabled document class.
    outcome = _sweep(session, region, function_name, "nightly-sweep")

    # Transient provider throttling must not change the observable state:
    # retry only the classes that are expected to succeed.
    for attempt in range(3):
        stragglers = {p for p in EXPECTED_SUCCESSES if outcome.get(p) != "SUCCEEDED"}
        if not stragglers:
            break
        print(f"retrying stragglers {sorted(stragglers)} (attempt {attempt + 1})")
        time.sleep(10)
        outcome.update(
            _sweep(
                session,
                region,
                function_name,
                f"nightly-sweep-retry-{attempt + 1}",
                stragglers,
            )
        )

    failed = {p for p, s in outcome.items() if s == "FAILED"}
    succeeded = {p for p, s in outcome.items() if s == "SUCCEEDED"}
    if failed != EXPECTED_FAILURES or not EXPECTED_SUCCESSES.issubset(succeeded):
        raise RuntimeError(
            f"unexpected sweep outcome: failed={sorted(failed)} succeeded={sorted(succeeded)}; "
            f"expected failed={sorted(EXPECTED_FAILURES)} succeeded={sorted(EXPECTED_SUCCESSES)}"
        )

    # Drive the S3-notification path so failures span more than one CloudWatch
    # period and the ingestion route is exercised end to end.
    s3 = session.client("s3", region_name=region)
    for key, body in INCOMING_DOCS.items():
        s3.put_object(
            Bucket=bucket,
            Key=key,
            Body=body.encode("utf-8"),
            ContentType="text/plain; charset=utf-8",
            ServerSideEncryption="AES256",
        )
    print(f"dropped {len(INCOMING_DOCS)} documents into s3://{bucket}/incoming/")

    deadline = time.time() + 240
    while time.time() < deadline:
        rows = _scan_runs(session, region, runs_table)
        notif = {r["profileId"] for r in rows if r.get("source") == "s3-notification"}
        if notif >= EXPECTED_FAILURES:
            print(f"s3-notification runs recorded for {sorted(notif)}")
            break
        time.sleep(15)
    else:
        raise RuntimeError(
            "s3-notification triggered runs never reached the run ledger"
        )

    rows = _scan_runs(session, region, runs_table)
    validation = [
        r
        for r in rows
        if r.get("status") == "FAILED" and r.get("errorCode") == "ValidationException"
    ]
    if {r["profileId"] for r in validation} != EXPECTED_FAILURES:
        raise RuntimeError(
            f"run ledger does not carry the expected ValidationException rows: "
            f"{sorted({r['profileId'] for r in validation})}"
        )
    print(
        f"run ledger holds {len(rows)} rows, {len(validation)} ValidationException failures"
    )

    _wait_for_logs(session, region, log_group, "EXTRACTION_FAILED")
    _wait_for_logs(session, region, log_group, "EXTRACTION_SUCCEEDED")
    _wait_for_alarm(session, region, alarm_name, "ALARM")

    # Prefer the setup-time manifest sha over the live one: the manifest is
    # what the restore path anchors to.
    baseline_sha = ""
    if manifest and isinstance(manifest.get("codeSha256"), str):
        baseline_sha = manifest["codeSha256"]
    if not baseline_sha:
        lam = session.client("lambda", region_name=region)
        try:
            baseline_sha = (
                lam.get_function(FunctionName=function_name)
                .get("Configuration", {})
                .get("CodeSha256", "")
            )
        except ClientError as exc:
            print(f"warning: could not read router Lambda CodeSha256: {exc}")

    PLACEHOLDER_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    # The 8-hex prefix must match [metadata].id in task.toml.
    PLACEHOLDER_OUTPUT.write_text(
        json.dumps({"f160440f-router_lambda_baseline_sha": baseline_sha})
    )
    print(f"pre_invoke complete (router_lambda_baseline_sha={baseline_sha!r})")


if __name__ == "__main__":
    run()
