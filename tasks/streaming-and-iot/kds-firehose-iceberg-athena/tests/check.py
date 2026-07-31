"""Programmatic verifier for kds-firehose-iceberg-athena.

Validates the agent built a Glue-backed Iceberg table + a KDS-sourced
Firehose delivery stream that lands records into that table on the
precondition sink bucket.

Per AWS docs:
  - https://docs.aws.amazon.com/firehose/latest/APIReference/API_DescribeDeliveryStream.html
  - https://docs.aws.amazon.com/firehose/latest/APIReference/API_IcebergDestinationDescription.html
  - https://docs.aws.amazon.com/glue/latest/webapi/API_GetTable.html
"""

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_REGION", "us-east-1")

KINESIS_STREAM_NAME = os.environ.get("KINESIS_STREAM_NAME", "")
S3_SINK_BUCKET = os.environ.get("S3_SINK_BUCKET", "")
FIREHOSE_ROLE_NAME = os.environ.get("FIREHOSE_ROLE_NAME", "")

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    AGENT_OUTPUT = {}

REQUIRED_OUTPUT_KEYS = ("delivery_stream_name", "glue_database_name", "glue_table_name")
CHOSEN_DELIVERY_STREAM = AGENT_OUTPUT.get("delivery_stream_name") or ""
CHOSEN_DATABASE = AGENT_OUTPUT.get("glue_database_name") or ""
CHOSEN_TABLE = AGENT_OUTPUT.get("glue_table_name") or ""

DESCRIBE_POLL_SEC = 60
DESCRIBE_INTERVAL_SEC = 5


def _firehose():
    return boto3.client("firehose", region_name=REGION)


def _glue():
    return boto3.client("glue", region_name=REGION)


def _expected_kinesis_arn() -> str:
    sts = boto3.client("sts", region_name=REGION)
    try:
        account = sts.get_caller_identity()["Account"]
    except ClientError:
        return ""
    return f"arn:aws:kinesis:{REGION}:{account}:stream/{KINESIS_STREAM_NAME}"


def _expected_bucket_arn() -> str:
    return f"arn:aws:s3:::{S3_SINK_BUCKET}"


def _expected_role_arn(account: str) -> str:
    return f"arn:aws:iam::{account}:role/{FIREHOSE_ROLE_NAME}"


def _describe_stream() -> dict | None:
    if not CHOSEN_DELIVERY_STREAM:
        return None
    try:
        resp = _firehose().describe_delivery_stream(
            DeliveryStreamName=CHOSEN_DELIVERY_STREAM
        )
    except ClientError:
        return None
    return resp.get("DeliveryStreamDescription")


def _wait_active(desc: dict | None) -> dict | None:
    """If the stream is in CREATING, poll up to DESCRIBE_POLL_SEC for ACTIVE."""
    if desc is None:
        return None
    state = desc.get("DeliveryStreamStatus")
    if state == "ACTIVE":
        return desc
    if state != "CREATING":
        return desc  # CREATING_FAILED / DELETING -- return what we have
    elapsed = 0
    while elapsed < DESCRIBE_POLL_SEC:
        time.sleep(DESCRIBE_INTERVAL_SEC)
        elapsed += DESCRIBE_INTERVAL_SEC
        new = _describe_stream()
        if new is None:
            return None
        if new.get("DeliveryStreamStatus") == "ACTIVE":
            return new
    return desc  # timed out -- return last view


@criterion(description="agent wrote agent-output.json with all required keys")
def output_contract_followed(workspace: Path) -> bool:
    return bool(AGENT_OUTPUT) and all(k in AGENT_OUTPUT for k in REQUIRED_OUTPUT_KEYS)


@criterion(description="Glue database + table exist and table is Iceberg-marked")
def glue_iceberg_table_exists(workspace: Path) -> bool:
    if not CHOSEN_DATABASE or not CHOSEN_TABLE:
        return False
    try:
        resp = _glue().get_table(DatabaseName=CHOSEN_DATABASE, Name=CHOSEN_TABLE)
    except ClientError:
        return False
    table = resp.get("Table") or {}
    table_type = (table.get("TableType") or "").upper()
    params = table.get("Parameters") or {}
    iceberg_param = (
        params.get("table_type") or params.get("EXTERNAL_TABLE_TYPE") or ""
    ).upper() == "ICEBERG"
    return table_type == "ICEBERG" or iceberg_param


@criterion(
    description="Firehose delivery stream is ACTIVE, KinesisStreamAsSource, and sourced from the precondition stream"
)
def delivery_stream_iceberg_active(workspace: Path) -> bool:
    desc = _wait_active(_describe_stream())
    if desc is None:
        return False
    if desc.get("DeliveryStreamStatus") != "ACTIVE":
        return False
    if desc.get("DeliveryStreamType") != "KinesisStreamAsSource":
        return False
    src = (desc.get("Source") or {}).get("KinesisStreamSourceDescription") or {}
    expected = _expected_kinesis_arn()
    return bool(expected) and src.get("KinesisStreamARN") == expected


@criterion(
    description="delivery stream's Iceberg destination uses the precondition role, sink bucket, and the agent's table"
)
def iceberg_destination_correct(workspace: Path) -> bool:
    desc = _describe_stream()
    if desc is None:
        return False
    sts = boto3.client("sts", region_name=REGION)
    try:
        account = sts.get_caller_identity()["Account"]
    except ClientError:
        return False
    expected_role_arn = _expected_role_arn(account)
    expected_bucket_arn = _expected_bucket_arn()

    for dest in desc.get("Destinations") or []:
        iceberg = dest.get("IcebergDestinationDescription")
        if not iceberg:
            continue
        if iceberg.get("RoleARN") != expected_role_arn:
            continue
        s3_dest = iceberg.get("S3DestinationDescription") or {}
        if s3_dest.get("BucketARN") != expected_bucket_arn:
            continue
        table_configs = iceberg.get("DestinationTableConfigurationList") or []
        if any(
            tc.get("DestinationDatabaseName") == CHOSEN_DATABASE
            and tc.get("DestinationTableName") == CHOSEN_TABLE
            for tc in table_configs
        ):
            return True
    return False


# End-to-end behavioral check: tunables. Iceberg buffer hints
# (BufferingHints in IcebergDestinationConfiguration) default to 60s OR
# 5 MiB. First-write activation on a fresh stream can take 2-3 min
# extra (Firehose probes the Glue catalog, S3 paths, etc.) so we poll
# for up to ~9 min total. PUT_BATCH_RECORDS is small to fit in one
# put_records call (limit: 500 records / 5 MiB).
DATA_FLOW_PUT_RECORDS = 25
DATA_FLOW_POLL_SEC = 900
DATA_FLOW_INTERVAL_SEC = 20
# Slack to absorb clock skew between the verifier container and S3 -
# S3 LastModified can be a few seconds behind our local now().
DATA_FLOW_CUTOFF_SLACK_SEC = 30


@criterion(
    description="end-to-end: records put to KDS land in the S3 sink within the Iceberg flush window"
)
def records_flow_kds_to_s3(workspace: Path) -> bool:
    if not KINESIS_STREAM_NAME or not S3_SINK_BUCKET:
        return False
    s3_client = boto3.client("s3", region_name=REGION)
    kinesis = boto3.client("kinesis", region_name=REGION)

    # Snapshot bucket inventory (modification timestamps) before producing.
    # We pass over data left by prior trial runs by remembering the most
    # recent LastModified seen now and only counting strictly newer
    # objects after the put. This avoids counting residue from a previous
    # successful run as a false positive. Subtract a slack window to
    # absorb clock skew between the verifier container and S3.
    from datetime import timedelta

    cutoff = datetime.now(timezone.utc) - timedelta(seconds=DATA_FLOW_CUTOFF_SLACK_SEC)
    try:
        # Touch S3 once to confirm reachability and bail early if the
        # bucket is misconfigured.
        s3_client.list_objects_v2(Bucket=S3_SINK_BUCKET, MaxKeys=1)
    except ClientError:
        return False

    # Put records. Each is a small JSON envelope, so even if the agent's
    # schema is `id BIGINT, payload STRING` Firehose will land them in a
    # processing-error prefix rather than in the data prefix -- both
    # outcomes prove the source-to-sink path is wired.
    payload_records = [
        {
            "Data": json.dumps(
                {"id": int(time.time() * 1000) + i, "payload": f"e2e-{i}"}
            ).encode("utf-8")
            + b"\n",
            "PartitionKey": f"k{i % 4}",
        }
        for i in range(DATA_FLOW_PUT_RECORDS)
    ]
    try:
        kinesis.put_records(StreamName=KINESIS_STREAM_NAME, Records=payload_records)
    except ClientError:
        return False

    # Poll for new objects landed after the cutoff.
    elapsed = 0
    paginator = s3_client.get_paginator("list_objects_v2")
    while elapsed < DATA_FLOW_POLL_SEC:
        time.sleep(DATA_FLOW_INTERVAL_SEC)
        elapsed += DATA_FLOW_INTERVAL_SEC
        try:
            for page in paginator.paginate(Bucket=S3_SINK_BUCKET):
                for obj in page.get("Contents") or []:
                    last_modified = obj.get("LastModified")
                    if last_modified and last_modified > cutoff:
                        return True
        except ClientError:
            continue
    return False
