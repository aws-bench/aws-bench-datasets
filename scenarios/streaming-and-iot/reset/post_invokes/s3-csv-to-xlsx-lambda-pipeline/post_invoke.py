"""Rollback for s3-csv-to-xlsx-lambda-pipeline.

Tears down everything the agent created against the precondition bucket:
  1. Clear the bucket's notification configuration (only if there's a
     LambdaFunctionConfigurations entry -- don't wipe a config we didn't
     add).
  2. Delete every .xlsx object under the OUTPUT_PREFIX.
  3. Delete the agent's Lambda function and its execution role
     (gated on trust-policy = lambda.amazonaws.com).

Best-effort: errors print to stderr; exit 0.
"""

import json
import os
import sys
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

from reset import reset_data_plane

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
ETL_BUCKET = os.environ.get("ETL_BUCKET", "")
OUTPUT_PREFIX = os.environ.get("OUTPUT_PREFIX", "")

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    AGENT_OUTPUT = {}

CHOSEN_LAMBDA_NAME = AGENT_OUTPUT.get("lambda_function_name") or ""


def _wipe_notification(s3, errors: list[str]) -> None:
    """Empty the notification configuration if it has any Lambda entries
    we attached. Leave it alone if there are none.
    """
    if not ETL_BUCKET:
        return
    try:
        cfg = s3.get_bucket_notification_configuration(Bucket=ETL_BUCKET)
    except ClientError as e:
        errors.append(f"get notification: {e}")
        return
    if not cfg.get("LambdaFunctionConfigurations"):
        return
    try:
        s3.put_bucket_notification_configuration(
            Bucket=ETL_BUCKET,
            NotificationConfiguration={},
        )
    except ClientError as e:
        errors.append(f"clear notification: {e}")


def _delete_xlsx_outputs(s3, errors: list[str]) -> None:
    if not ETL_BUCKET or not OUTPUT_PREFIX:
        return
    try:
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=ETL_BUCKET, Prefix=OUTPUT_PREFIX):
            keys = [
                {"Key": o["Key"]}
                for o in page.get("Contents", [])
                if (o.get("Key") or "").endswith(".xlsx")
            ]
            if not keys:
                continue
            try:
                s3.delete_objects(
                    Bucket=ETL_BUCKET,
                    Delete={"Objects": keys, "Quiet": True},
                )
            except ClientError as e:
                errors.append(f"delete {len(keys)} from {ETL_BUCKET}: {e}")
    except ClientError as e:
        errors.append(f"list {ETL_BUCKET}/{OUTPUT_PREFIX}: {e}")


def _delete_role(role_arn: str | None, errors: list[str]) -> None:
    if not role_arn:
        return
    role_name = role_arn.split("/")[-1]
    iam = boto3.client("iam")
    try:
        role = iam.get_role(RoleName=role_name)
    except ClientError as e:
        errors.append(f"get role {role_name}: {e}")
        return
    trust = role.get("Role", {}).get("AssumeRolePolicyDocument") or {}
    if isinstance(trust, str):
        try:
            trust = json.loads(trust)
        except json.JSONDecodeError:
            trust = {}
    statements = trust.get("Statement") or []
    if isinstance(statements, dict):
        statements = [statements]
    if not any(
        (s.get("Principal") or {}).get("Service", "")
        in ("lambda.amazonaws.com", ["lambda.amazonaws.com"])
        for s in statements
    ):
        return
    try:
        for p in iam.list_attached_role_policies(RoleName=role_name).get(
            "AttachedPolicies", []
        ):
            try:
                iam.detach_role_policy(RoleName=role_name, PolicyArn=p["PolicyArn"])
            except ClientError as e:
                errors.append(f"detach {p['PolicyArn']}: {e}")
        for pn in iam.list_role_policies(RoleName=role_name).get("PolicyNames", []):
            try:
                iam.delete_role_policy(RoleName=role_name, PolicyName=pn)
            except ClientError as e:
                errors.append(f"delete inline {pn}: {e}")
        iam.delete_role(RoleName=role_name)
    except ClientError as e:
        errors.append(f"role cleanup {role_name}: {e}")


def _delete_log_group(logs, errors: list[str]) -> None:
    """Delete the Lambda's auto-created log group. AWS creates
    /aws/lambda/<fn> on first invocation and deleting the function does
    not remove it -- left behind, it shows up as environment drift.
    """
    if not CHOSEN_LAMBDA_NAME:
        return
    try:
        logs.delete_log_group(logGroupName=f"/aws/lambda/{CHOSEN_LAMBDA_NAME}")
    except logs.exceptions.ResourceNotFoundException:
        pass
    except ClientError as e:
        errors.append(f"delete log group: {e}")


def main() -> int:
    s3 = boto3.client("s3", region_name=REGION)
    lambda_client = boto3.client("lambda", region_name=REGION)
    logs = boto3.client("logs", region_name=REGION)
    errors: list[str] = []

    _wipe_notification(s3, errors)
    _delete_xlsx_outputs(s3, errors)

    if CHOSEN_LAMBDA_NAME:
        try:
            cfg = lambda_client.get_function(FunctionName=CHOSEN_LAMBDA_NAME).get(
                "Configuration", {}
            )
            role_arn = cfg.get("Role") or ""
        except ClientError as e:
            errors.append(f"get function: {e}")
            role_arn = ""
        try:
            lambda_client.delete_function(FunctionName=CHOSEN_LAMBDA_NAME)
        except ClientError as e:
            errors.append(f"delete function: {e}")
        # After the function is gone so a late invocation can't recreate it.
        _delete_log_group(logs, errors)
        if role_arn:
            _delete_role(role_arn, errors)

    data_plane_errors = reset_data_plane(region=REGION)

    for err in errors + data_plane_errors:
        print(err, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
