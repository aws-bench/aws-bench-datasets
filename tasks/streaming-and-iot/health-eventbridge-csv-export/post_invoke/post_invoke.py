"""Rollback for health-eventbridge-csv-export.

Tears down the agent's Lambda, the rule, the rule's targets, the Lambda's
EventBridge resource-policy entry, and any CSV/JSON outputs the Lambda
wrote to the export bucket.

The custom event bus + the Health IAM role + the export bucket are
precondition resources that stay; we only remove what the agent added
on top of them.

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
EVENT_BUS_NAME = os.environ.get("EVENT_BUS_NAME", "")
EXPORT_BUCKET = os.environ.get("EXPORT_BUCKET", "")

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    AGENT_OUTPUT = {}

CHOSEN_LAMBDA_NAME = AGENT_OUTPUT.get("lambda_function_name") or ""
CHOSEN_RULE_NAME = AGENT_OUTPUT.get("rule_name") or ""


def _remove_targets_and_rule(events, errors: list[str]) -> None:
    if not CHOSEN_RULE_NAME or not EVENT_BUS_NAME:
        return
    try:
        resp = events.list_targets_by_rule(
            Rule=CHOSEN_RULE_NAME, EventBusName=EVENT_BUS_NAME
        )
    except ClientError as e:
        errors.append(f"list targets: {e}")
        return
    target_ids = [t.get("Id") for t in resp.get("Targets", []) if t.get("Id")]
    if target_ids:
        try:
            events.remove_targets(
                Rule=CHOSEN_RULE_NAME, EventBusName=EVENT_BUS_NAME, Ids=target_ids
            )
        except ClientError as e:
            errors.append(f"remove targets: {e}")
    try:
        events.delete_rule(Name=CHOSEN_RULE_NAME, EventBusName=EVENT_BUS_NAME)
    except ClientError as e:
        errors.append(f"delete rule: {e}")


def _delete_function(lambda_client, errors: list[str]) -> None:
    if not CHOSEN_LAMBDA_NAME:
        return
    # The Lambda uses the precondition Health role; we don't delete the role.
    # We also don't bother removing the Lambda's resource-policy entries -- the
    # function deletion drops the whole resource policy with it.
    try:
        lambda_client.delete_function(FunctionName=CHOSEN_LAMBDA_NAME)
    except ClientError as e:
        errors.append(f"delete function: {e}")


def _wipe_outputs(s3, errors: list[str]) -> None:
    if not EXPORT_BUCKET:
        return
    try:
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=EXPORT_BUCKET):
            keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
            if not keys:
                continue
            try:
                s3.delete_objects(
                    Bucket=EXPORT_BUCKET, Delete={"Objects": keys, "Quiet": True}
                )
            except ClientError as e:
                errors.append(f"delete batch: {e}")
    except ClientError as e:
        errors.append(f"list {EXPORT_BUCKET}: {e}")


def main() -> int:
    events = boto3.client("events", region_name=REGION)
    lambda_client = boto3.client("lambda", region_name=REGION)
    s3 = boto3.client("s3", region_name=REGION)
    errors: list[str] = []

    _remove_targets_and_rule(events, errors)
    _delete_function(lambda_client, errors)
    _wipe_outputs(s3, errors)
    data_plane_errors = reset_data_plane(region=REGION)

    for err in errors + data_plane_errors:
        print(err, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
