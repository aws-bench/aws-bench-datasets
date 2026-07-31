"""Rollback for kds-firehose-iceberg-athena.

Tears down the agent's Firehose delivery stream, the Glue database +
table, and any objects Firehose wrote to the sink bucket. The KDS source
stream + the Firehose role + the sink bucket are precondition resources
that stay.

Best-effort: errors print to stderr; exit 0.
"""

import json
import os
import sys
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

from reset import reset_data_plane

REGION = os.environ.get("AWS_REGION", "us-east-1")
S3_SINK_BUCKET = os.environ.get("S3_SINK_BUCKET", "")

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    AGENT_OUTPUT = {}

CHOSEN_DELIVERY_STREAM = AGENT_OUTPUT.get("delivery_stream_name") or ""
CHOSEN_DATABASE = AGENT_OUTPUT.get("glue_database_name") or ""
CHOSEN_TABLE = AGENT_OUTPUT.get("glue_table_name") or ""


def _delete_stream(firehose, errors: list[str]) -> None:
    if not CHOSEN_DELIVERY_STREAM:
        return
    try:
        firehose.delete_delivery_stream(DeliveryStreamName=CHOSEN_DELIVERY_STREAM)
    except ClientError as e:
        errors.append(f"delete delivery stream: {e}")


def _delete_glue(glue, errors: list[str]) -> None:
    # Delete table first, then database (DeleteDatabase will fail if non-empty
    # in some catalog modes; explicit table delete is defensive).
    if CHOSEN_DATABASE and CHOSEN_TABLE:
        try:
            glue.delete_table(DatabaseName=CHOSEN_DATABASE, Name=CHOSEN_TABLE)
        except ClientError as e:
            errors.append(f"delete glue table: {e}")
    if CHOSEN_DATABASE:
        try:
            glue.delete_database(Name=CHOSEN_DATABASE)
        except ClientError as e:
            errors.append(f"delete glue database: {e}")


def _wipe_sink(s3, errors: list[str]) -> None:
    if not S3_SINK_BUCKET:
        return
    try:
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=S3_SINK_BUCKET):
            keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
            if not keys:
                continue
            try:
                s3.delete_objects(
                    Bucket=S3_SINK_BUCKET, Delete={"Objects": keys, "Quiet": True}
                )
            except ClientError as e:
                errors.append(f"delete batch: {e}")
    except ClientError as e:
        errors.append(f"list sink: {e}")


def main() -> int:
    firehose = boto3.client("firehose", region_name=REGION)
    glue = boto3.client("glue", region_name=REGION)
    s3 = boto3.client("s3", region_name=REGION)
    errors: list[str] = []

    _delete_stream(firehose, errors)
    _delete_glue(glue, errors)
    _wipe_sink(s3, errors)
    data_plane_errors = reset_data_plane(region=REGION)

    for err in errors + data_plane_errors:
        print(err, file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
