"""Post-invoke reset for fix-bedrock-toolchoice-per-model-capability.

Restores the DocIntel extraction scenario to its scenario baseline: the router
Lambda's code and env vars from the S3 manifest, every routing-profile row, an
empty run ledger, no objects under incoming/, and the extraction-failure alarm
back to OK so its latched state does not carry into the next trial.

PROFILE_BASELINE below must stay identical to pre_invoke.py::PROFILE_BASELINE.

Best-effort: the whole body is wrapped in try/except so partial failures never raise.
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from typing import Any

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_DEFAULT_REGION", os.environ.get("AWS_REGION", "us-east-1"))
PROFILES_TABLE = os.environ.get("PROFILES_TABLE", "")
RUNS_TABLE = os.environ.get("RUNS_TABLE", "")
DOCUMENTS_BUCKET = os.environ.get("DOCUMENTS_BUCKET", "")
ALARM_NAME = os.environ.get("ALARM_NAME", "")
FUNCTION_NAME = os.environ.get("FUNCTION_NAME", "")

# Stable S3 keys holding the router-Lambda baseline captured at setup time.
# Must mirror the setup script under scenarios/.../scenario/setup/.
ROUTER_BASELINE_ZIP_KEY = "_baseline/router.zip"
ROUTER_BASELINE_MANIFEST_KEY = "_baseline/manifest.json"

# Mirrors pre_invoke.py::PROFILE_BASELINE (scenario baseline).
PROFILE_BASELINE: dict[str, dict[str, Any]] = {
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


def _load_baseline_manifest(session: boto3.Session) -> dict[str, Any] | None:
    """Fetch the router-Lambda baseline manifest captured at setup time.

    Returns None (with a stderr note) when the manifest is missing or malformed
    — hooks then fall back to their inline PROFILE_BASELINE reset and skip the
    Lambda restore.
    """
    if not DOCUMENTS_BUCKET:
        return None
    s3 = session.client("s3", region_name=REGION)
    try:
        obj = s3.get_object(Bucket=DOCUMENTS_BUCKET, Key=ROUTER_BASELINE_MANIFEST_KEY)
        payload = obj["Body"].read().decode("utf-8")
        manifest = json.loads(payload)
    except (ClientError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        print(
            f"router baseline manifest unavailable at s3://{DOCUMENTS_BUCKET}/"
            f"{ROUTER_BASELINE_MANIFEST_KEY}: {exc}",
            file=sys.stderr,
        )
        return None
    if not isinstance(manifest, dict):
        return None
    return manifest


def _restore_router_lambda(
    session: boto3.Session, manifest: dict[str, Any] | None
) -> None:
    """Restore the router Lambda's CodeSha256 and env vars to the baseline
    captured at scenario-setup time. Idempotent: if the function already
    matches the baseline, nothing is written.

    Best-effort. Failures degrade to warnings so post_invoke never blocks the
    next trial.
    """
    if not FUNCTION_NAME:
        print("FUNCTION_NAME not set; skipping router-Lambda restore", file=sys.stderr)
        return
    if not manifest:
        print(
            "no router baseline manifest; skipping router-Lambda restore",
            file=sys.stderr,
        )
        return
    if not DOCUMENTS_BUCKET:
        print(
            "DOCUMENTS_BUCKET not set; skipping router-Lambda restore", file=sys.stderr
        )
        return

    lam = session.client("lambda", region_name=REGION)
    s3 = session.client("s3", region_name=REGION)

    try:
        cfg = lam.get_function_configuration(FunctionName=FUNCTION_NAME)
    except ClientError as exc:
        print(f"failed to describe router {FUNCTION_NAME}: {exc}", file=sys.stderr)
        return

    baseline_sha = manifest.get("codeSha256", "") or ""
    baseline_env = manifest.get("environment", {}) or {}
    baseline_zip_key = manifest.get("codeS3Key") or ROUTER_BASELINE_ZIP_KEY
    baseline_zip_bucket = manifest.get("codeS3Bucket") or DOCUMENTS_BUCKET

    current_sha = cfg.get("CodeSha256", "") or ""
    current_env = (cfg.get("Environment", {}) or {}).get("Variables", {}) or {}

    # 1) Restore code if the sha has drifted from the deployed baseline.
    if baseline_sha and current_sha != baseline_sha:
        try:
            zip_obj = s3.get_object(Bucket=baseline_zip_bucket, Key=baseline_zip_key)
            zip_bytes = zip_obj["Body"].read()
            lam.update_function_code(
                FunctionName=FUNCTION_NAME,
                ZipFile=zip_bytes,
                Publish=False,
            )
            _wait_for_update(lam, FUNCTION_NAME)
            print(
                f"restored router {FUNCTION_NAME} code {current_sha!r} -> baseline {baseline_sha!r}"
            )
        except ClientError as exc:
            print(f"failed to restore router code: {exc}", file=sys.stderr)
    else:
        print(f"router {FUNCTION_NAME} code already at baseline sha {baseline_sha!r}")

    # 2) Restore env vars if any drift is present.
    if isinstance(baseline_env, dict) and current_env != baseline_env:
        try:
            lam.update_function_configuration(
                FunctionName=FUNCTION_NAME,
                Environment={"Variables": dict(baseline_env)},
            )
            _wait_for_update(lam, FUNCTION_NAME)
            print(
                f"restored router {FUNCTION_NAME} env vars to baseline ({len(baseline_env)} keys)"
            )
        except ClientError as exc:
            print(f"failed to restore router env vars: {exc}", file=sys.stderr)
    else:
        print(f"router {FUNCTION_NAME} env vars already at baseline")


def _wait_for_update(lam: Any, function_name: str) -> None:
    """Block until the Lambda's LastUpdateStatus is 'Successful'.

    We use the SDK waiter but cap the total wait so a stuck update never blocks
    the whole post_invoke.
    """
    try:
        waiter = lam.get_waiter("function_updated")
        waiter.wait(
            FunctionName=function_name, WaiterConfig={"Delay": 3, "MaxAttempts": 30}
        )
    except Exception as exc:  # noqa: BLE001 — waiter raises many exception types
        print(
            f"warning: function_updated waiter did not complete: {exc}", file=sys.stderr
        )


def _reset_profiles(session: boto3.Session, manifest: dict[str, Any] | None) -> None:
    if not PROFILES_TABLE:
        print("PROFILES_TABLE not set; skipping profile reset", file=sys.stderr)
        return
    table = session.resource("dynamodb", region_name=REGION).Table(PROFILES_TABLE)

    # Prefer the full profile records captured in the S3 manifest — these
    # include every non-model column (toolSchema, promptPreamble, maxTokens,
    # temperature, owner, etc.). Fall back to the inline PROFILE_BASELINE
    # subset if the manifest is unavailable.
    manifest_rows: list[dict[str, Any]] = []
    if isinstance(manifest, dict):
        raw = manifest.get("profiles")
        if isinstance(raw, list):
            manifest_rows = [
                dict(r) for r in raw if isinstance(r, dict) and r.get("profileId")
            ]

    if manifest_rows:
        updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        try:
            with table.batch_writer() as batch:
                for row in manifest_rows:
                    item = dict(row)
                    item["updatedAt"] = updated_at
                    batch.put_item(Item=item)
        except ClientError as exc:
            print(f"failed full profile restore from manifest: {exc}", file=sys.stderr)
            manifest_rows = []  # fall through to subset reset
        else:
            print(
                f"restored {len(manifest_rows)} full profile rows from manifest into {PROFILES_TABLE}"
            )
            return

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
            code = exc.response.get("Error", {}).get("Code", "")
            if code == "ConditionalCheckFailedException":
                # Row absent — nothing to reset; pre_invoke will re-seed.
                print(f"profile {profile_id} missing; skipping", file=sys.stderr)
                continue
            print(f"failed to reset profile {profile_id}: {exc}", file=sys.stderr)
    print(f"reset {len(PROFILE_BASELINE)} routing profiles in {PROFILES_TABLE}")


def _clear_runs(session: boto3.Session) -> None:
    if not RUNS_TABLE:
        print("RUNS_TABLE not set; skipping run-ledger clear", file=sys.stderr)
        return
    table = session.resource("dynamodb", region_name=REGION).Table(RUNS_TABLE)
    deleted = 0
    kwargs: dict[str, Any] = {"ProjectionExpression": "profileId, runId"}
    try:
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
    except ClientError as exc:
        print(f"failed to clear runs table: {exc}", file=sys.stderr)
    print(f"cleared {deleted} rows from {RUNS_TABLE}")


def _clear_incoming(session: boto3.Session) -> None:
    if not DOCUMENTS_BUCKET:
        print("DOCUMENTS_BUCKET not set; skipping incoming/ cleanup", file=sys.stderr)
        return
    s3 = session.client("s3", region_name=REGION)
    deleted = 0
    kwargs: dict[str, Any] = {"Bucket": DOCUMENTS_BUCKET, "Prefix": "incoming/"}
    try:
        while True:
            page = s3.list_objects_v2(**kwargs)
            keys = [{"Key": obj["Key"]} for obj in page.get("Contents", [])]
            if keys:
                s3.delete_objects(
                    Bucket=DOCUMENTS_BUCKET, Delete={"Objects": keys, "Quiet": True}
                )
                deleted += len(keys)
            if not page.get("IsTruncated"):
                break
            kwargs["ContinuationToken"] = page["NextContinuationToken"]
    except ClientError as exc:
        print(f"failed to clean incoming/ objects: {exc}", file=sys.stderr)
    print(f"removed {deleted} incoming/* objects from s3://{DOCUMENTS_BUCKET}/")


def _reset_alarm(session: boto3.Session) -> None:
    if not ALARM_NAME:
        print("ALARM_NAME not set; skipping alarm reset", file=sys.stderr)
        return
    cw = session.client("cloudwatch", region_name=REGION)
    try:
        cw.set_alarm_state(
            AlarmName=ALARM_NAME,
            StateValue="OK",
            StateReason="post_invoke: break latched ALARM before next trial",
        )
        print(f"reset alarm {ALARM_NAME} to OK")
    except ClientError as exc:
        print(f"failed to reset alarm {ALARM_NAME}: {exc}", file=sys.stderr)


def main() -> int:
    try:
        session = boto3.Session(region_name=REGION)
        # Restore the router Lambda before the profile reset.
        manifest = _load_baseline_manifest(session)
        _restore_router_lambda(session, manifest)
        _reset_profiles(session, manifest)
        _clear_runs(session)
        _clear_incoming(session)
        _reset_alarm(session)
    except Exception:
        # Never raise: record the traceback and return 0.
        print("post_invoke encountered a non-fatal error:", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
