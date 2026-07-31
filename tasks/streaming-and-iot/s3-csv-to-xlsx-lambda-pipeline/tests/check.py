"""Programmatic verifier for s3-csv-to-xlsx-lambda-pipeline.

Validates the agent built an S3-triggered Lambda pipeline that converts
CSVs under raw/ to .xlsx files under converted/.

Per AWS docs:
  - https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-walkthrough.html
  - https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetBucketNotificationConfiguration.html
  - https://docs.aws.amazon.com/lambda/latest/dg/access-control-resource-based.html
"""

import io
import json
import os
import time
import uuid
import zipfile
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_REGION", "us-east-1")
ETL_BUCKET = os.environ.get("ETL_BUCKET", "")
OUTPUT_PREFIX = os.environ.get("OUTPUT_PREFIX", "")  # e.g. "converted/"

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    AGENT_OUTPUT = {}

REQUIRED_OUTPUT_KEYS = ("lambda_function_name",)
CHOSEN_LAMBDA_NAME = AGENT_OUTPUT.get("lambda_function_name") or ""


def _s3():
    return boto3.client("s3", region_name=REGION)


def _lambda():
    return boto3.client("lambda", region_name=REGION)


def _get_lambda_arn() -> str | None:
    if not CHOSEN_LAMBDA_NAME:
        return None
    try:
        return _lambda().get_function(FunctionName=CHOSEN_LAMBDA_NAME)["Configuration"][
            "FunctionArn"
        ]
    except ClientError:
        return None


@criterion(description="agent wrote agent-output.json with all required keys")
def output_contract_followed(workspace: Path) -> bool:
    return bool(AGENT_OUTPUT) and all(k in AGENT_OUTPUT for k in REQUIRED_OUTPUT_KEYS)


@criterion(description="agent's reported Lambda function exists")
def lambda_exists(workspace: Path) -> bool:
    return _get_lambda_arn() is not None


@criterion(
    description="bucket notification has a LambdaFunctionConfiguration with prefix=raw/, suffix=.csv targeting the agent's Lambda"
)
def s3_notification_wired(workspace: Path) -> bool:
    if not ETL_BUCKET:
        return False
    arn = _get_lambda_arn()
    if not arn:
        return False
    try:
        cfg = _s3().get_bucket_notification_configuration(Bucket=ETL_BUCKET)
    except ClientError:
        return False
    for entry in cfg.get("LambdaFunctionConfigurations", []):
        if entry.get("LambdaFunctionArn") != arn:
            continue
        events = entry.get("Events") or []
        if not any(
            e == "s3:ObjectCreated:*" or e.startswith("s3:ObjectCreated:")
            for e in events
        ):
            continue
        rules = (entry.get("Filter") or {}).get("Key", {}).get("FilterRules") or []
        # Build a name->value map (filter rule names are case-insensitive).
        rule_map = {(r.get("Name") or "").lower(): r.get("Value") for r in rules}
        if rule_map.get("prefix") == "raw/" and rule_map.get("suffix") == ".csv":
            return True
    return False


@criterion(
    description="Lambda resource policy grants s3.amazonaws.com:InvokeFunction for the bucket"
)
def lambda_resource_policy_grants_s3(workspace: Path) -> bool:
    if not CHOSEN_LAMBDA_NAME or not ETL_BUCKET:
        return False
    try:
        resp = _lambda().get_policy(FunctionName=CHOSEN_LAMBDA_NAME)
    except ClientError:
        return False
    try:
        policy = json.loads(resp.get("Policy") or "{}")
    except json.JSONDecodeError:
        return False

    bucket_arn = f"arn:aws:s3:::{ETL_BUCKET}"
    statements = policy.get("Statement") or []
    if isinstance(statements, dict):
        statements = [statements]
    for stmt in statements:
        if (stmt.get("Effect") or "").lower() != "allow":
            continue
        principal = stmt.get("Principal") or {}
        svc = principal.get("Service") if isinstance(principal, dict) else principal
        if isinstance(svc, list):
            svc_match = "s3.amazonaws.com" in svc
        else:
            svc_match = svc == "s3.amazonaws.com"
        if not svc_match:
            continue
        actions = stmt.get("Action", [])
        if isinstance(actions, str):
            actions = [actions]
        if not any(a in {"lambda:InvokeFunction", "lambda:*", "*"} for a in actions):
            continue
        # SourceArn condition narrows to the bucket -- accept either an
        # exact match or a missing condition (the latter is permissive
        # but still valid for the s3-invoke-lambda pattern).
        cond = stmt.get("Condition") or {}
        arn_eq = cond.get("ArnLike", {}).get("AWS:SourceArn") or cond.get(
            "ArnEquals", {}
        ).get("AWS:SourceArn")
        if arn_eq is None:
            return True
        if arn_eq == bucket_arn or (isinstance(arn_eq, list) and bucket_arn in arn_eq):
            return True
    return False


@criterion(
    description="at least one .xlsx object exists under the configured output prefix"
)
def xlsx_in_converted_prefix(workspace: Path) -> bool:
    if not ETL_BUCKET or not OUTPUT_PREFIX:
        return False
    try:
        paginator = _s3().get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=ETL_BUCKET, Prefix=OUTPUT_PREFIX):
            for obj in page.get("Contents", []):
                if (obj.get("Key") or "").endswith(".xlsx"):
                    return True
    except ClientError:
        return False
    return False


def _list_xlsx_keys(s3) -> set[str]:
    """Every .xlsx key currently under the output prefix."""
    keys: set[str] = set()
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=ETL_BUCKET, Prefix=OUTPUT_PREFIX):
        for obj in page.get("Contents", []):
            key = obj.get("Key") or ""
            if key.endswith(".xlsx"):
                keys.add(key)
    return keys


def _is_real_xlsx(body: bytes) -> bool:
    """An .xlsx is an OPC (zip) package. A CSV renamed to .xlsx is not a
    valid zip and lacks the workbook parts, so this rejects that shortcut.
    """
    try:
        with zipfile.ZipFile(io.BytesIO(body)) as zf:
            names = set(zf.namelist())
    except zipfile.BadZipFile:
        return False
    # The workbook lives under xl/ (xl/workbook.xml for the main part).
    return "[Content_Types].xml" in names and any(n.startswith("xl/") for n in names)


@criterion(
    description="an object under the output prefix is a valid Excel workbook (real .xlsx, not a renamed CSV)"
)
def output_is_valid_xlsx(workspace: Path) -> bool:
    if not ETL_BUCKET or not OUTPUT_PREFIX:
        return False
    s3 = _s3()
    try:
        keys = _list_xlsx_keys(s3)
    except ClientError:
        return False
    for key in keys:
        try:
            body = s3.get_object(Bucket=ETL_BUCKET, Key=key)["Body"].read()
        except ClientError:
            continue
        if _is_real_xlsx(body):
            return True
    return False


@criterion(
    description="uploading a fresh CSV under raw/ produces a new .xlsx under the output prefix end-to-end"
)
def live_upload_triggers_pipeline(workspace: Path) -> bool:
    """Prove the S3->Lambda trigger actually fires (the other criteria are
    satisfiable by a manual backfill alone): snapshot the output prefix, then
    upload a fresh-key raw/ CSV each round and poll for a new .xlsx.

    An S3 notification config change "usually takes about five minutes to take
    effect" (AWS S3 User Guide); events before it arms are dropped and never
    redelivered, so a single probe can be lost with no recovery. Re-uploading
    a new key each round succeeds as soon as propagation completes and
    tolerates the variance past it. A broken pipeline converts nothing.
    """
    if not ETL_BUCKET or not OUTPUT_PREFIX:
        return False
    s3 = _s3()
    try:
        before = _list_xlsx_keys(s3)
    except ClientError:
        return False

    csv_body = b"id,name,value\n1,alpha,100\n2,beta,200\n"
    probe_keys: list[str] = []
    deadline = time.time() + 360

    try:
        while time.time() < deadline:
            probe_key = f"raw/verifier-probe-{uuid.uuid4().hex[:12]}.csv"
            try:
                s3.put_object(Bucket=ETL_BUCKET, Key=probe_key, Body=csv_body)
                probe_keys.append(probe_key)
            except ClientError:
                pass
            time.sleep(30)
            try:
                if _list_xlsx_keys(s3) - before:
                    return True
            except ClientError:
                pass
        return False
    finally:
        for key in probe_keys:
            try:
                s3.delete_object(Bucket=ETL_BUCKET, Key=key)
            except ClientError:
                pass


@criterion(
    description="all 3 pre-seeded CSVs have corresponding .xlsx files under the output prefix"
)
def all_three_csvs_converted(workspace: Path) -> bool:
    """The instruction says 'Three CSVs are pre-seeded under raw/ and
    must end up converted by the time you finish.' Verify all 3 exist."""
    if not ETL_BUCKET or not OUTPUT_PREFIX:
        return False
    xlsx_count = 0
    try:
        paginator = _s3().get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=ETL_BUCKET, Prefix=OUTPUT_PREFIX):
            for obj in page.get("Contents", []):
                if (obj.get("Key") or "").endswith(".xlsx"):
                    xlsx_count += 1
    except ClientError:
        return False
    return xlsx_count >= 3
