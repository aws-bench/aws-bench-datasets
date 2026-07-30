"""Programmatic verifier for create-dynamodb-tables-from-csv.

Checks a table exists per source-bucket CSV with the required schema and data.
"""

import csv
import io
import json
import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_REGION", "us-east-1")
SOURCE_BUCKET = os.environ.get("DDB_SOURCE_BUCKET", "")

AGENT_OUTPUT_PATH = Path("/logs/agent/agent-output.json")
AGENT_OUTPUT: dict = {}
if AGENT_OUTPUT_PATH.exists():
    try:
        AGENT_OUTPUT = json.loads(AGENT_OUTPUT_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        pass

TABLE_NAMES = AGENT_OUTPUT.get("TableNamesList", [])


def _list_csv_objects() -> list[tuple[str, str]]:
    """Return (csv_key, table_name) for each .csv in the bucket; table_name is the stem."""
    if not SOURCE_BUCKET:
        return []
    s3 = boto3.client("s3", region_name=REGION)
    out: list[tuple[str, str]] = []
    try:
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=SOURCE_BUCKET):
            for obj in page.get("Contents") or []:
                key = obj["Key"]
                base = key.split("/")[-1]
                if base.lower().endswith(".csv"):
                    out.append((key, base[: -len(".csv")]))
    except ClientError:
        return []
    return out


def _describe_table(name: str) -> dict | None:
    try:
        return boto3.client("dynamodb", region_name=REGION).describe_table(
            TableName=name
        )["Table"]
    except ClientError:
        return None


EXPECTED_CSVS = _list_csv_objects()


@criterion(description="Agent output contains TableNamesList")
def output_contract(workspace: Path) -> bool:
    return isinstance(TABLE_NAMES, list) and len(TABLE_NAMES) > 0


@criterion(description="A DynamoDB table exists for every CSV file in the bucket")
def tables_exist(workspace: Path) -> bool:
    if not EXPECTED_CSVS:
        return False
    for _csv_key, table_name in EXPECTED_CSVS:
        if _describe_table(table_name) is None:
            return False
    return True


@criterion(
    description="Every table has a partition key, a sort key, and a global secondary index"
)
def tables_have_composite_key_and_gsi(workspace: Path) -> bool:
    if not EXPECTED_CSVS:
        return False
    for _csv_key, table_name in EXPECTED_CSVS:
        table = _describe_table(table_name)
        if table is None:
            return False
        key_types = {k.get("KeyType") for k in (table.get("KeySchema") or [])}
        if "HASH" not in key_types or "RANGE" not in key_types:
            return False
        if not (table.get("GlobalSecondaryIndexes") or []):
            return False
    return True


@criterion(description="Every table has at least as many items as its CSV has rows")
def data_loaded(workspace: Path) -> bool:
    if not EXPECTED_CSVS:
        return False
    s3 = boto3.client("s3", region_name=REGION)
    dynamodb = boto3.resource("dynamodb", region_name=REGION)
    for csv_key, table_name in EXPECTED_CSVS:
        try:
            resp = s3.get_object(Bucket=SOURCE_BUCKET, Key=csv_key)
            csv_content = resp["Body"].read().decode("utf-8")
            csv_rows = list(csv.DictReader(io.StringIO(csv_content)))
            scan = dynamodb.Table(table_name).scan(Select="COUNT")
            if scan["Count"] < len(csv_rows):
                return False
        except Exception:
            return False
    return True
