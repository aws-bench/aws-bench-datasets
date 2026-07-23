"""Programmatic verifier for create-s3-tables-with-compaction."""

import json
import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")

AGENT_OUTPUT_PATH = Path("/logs/agent/agent-output.json")
AGENT_OUTPUT: dict = {}
if AGENT_OUTPUT_PATH.exists():
    try:
        AGENT_OUTPUT = json.loads(AGENT_OUTPUT_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        pass

BUCKET_NAME = AGENT_OUTPUT.get("s3_table_bucket_name", "")
TABLE_WITH = AGENT_OUTPUT.get("s3_table_name_with_compaction", "")
TABLE_WITHOUT = AGENT_OUTPUT.get("s3_table_name_without_compaction", "")


@criterion(description="Agent output contains all 3 required keys")
def output_contract(workspace: Path) -> bool:
    return bool(BUCKET_NAME) and bool(TABLE_WITH) and bool(TABLE_WITHOUT)


@criterion(description="S3 table bucket exists")
def table_bucket_exists(workspace: Path) -> bool:
    if not BUCKET_NAME:
        return False
    try:
        s3tables = boto3.client("s3tables", region_name=REGION)
        resp = s3tables.list_table_buckets()
        return any(b["name"] == BUCKET_NAME for b in resp.get("tableBuckets", []))
    except ClientError:
        return False


@criterion(description="Both S3 tables exist")
def tables_exist(workspace: Path) -> bool:
    if not BUCKET_NAME or not TABLE_WITH or not TABLE_WITHOUT:
        return False
    try:
        s3tables = boto3.client("s3tables", region_name=REGION)
        resp = s3tables.list_tables(tableBucketARN=_get_bucket_arn())
        table_names = [t["name"] for t in resp.get("tables", [])]

        return TABLE_WITH in table_names and TABLE_WITHOUT in table_names
    except (ClientError, Exception):
        return False


@criterion(description="Compaction enabled on one table, disabled on other")
def compaction_correct(workspace: Path) -> bool:
    if not BUCKET_NAME or not TABLE_WITH or not TABLE_WITHOUT:
        return False
    try:
        s3tables = boto3.client("s3tables", region_name=REGION)
        bucket_arn = _get_bucket_arn()

        # Resolve each table's namespace from the live state rather than
        # assuming a fixed one; the task does not constrain the namespace.
        with_ns = _get_namespace_for(bucket_arn, TABLE_WITH)
        without_ns = _get_namespace_for(bucket_arn, TABLE_WITHOUT)
        if not with_ns or not without_ns:
            return False

        # Check table with compaction
        with_resp = s3tables.get_table_maintenance_configuration(
            tableBucketARN=bucket_arn, namespace=with_ns, name=TABLE_WITH
        )
        # Check table without compaction
        without_resp = s3tables.get_table_maintenance_configuration(
            tableBucketARN=bucket_arn, namespace=without_ns, name=TABLE_WITHOUT
        )

        # The table with compaction should have iceberg_compaction enabled
        with_config = with_resp.get("configuration", {})
        without_config = without_resp.get("configuration", {})

        # Enabled state lives in configuration.icebergCompaction.status
        # ('enabled' / 'disabled'), a sibling of `settings` (not inside it).
        with_enabled = (
            with_config.get("icebergCompaction", {}).get("status") == "enabled"
        )
        without_enabled = (
            without_config.get("icebergCompaction", {}).get("status") == "enabled"
        )

        # The compaction strategy lives in settings.icebergCompaction.strategy;
        # the task specifically calls for sort compaction.
        with_settings = with_config.get("icebergCompaction", {}).get("settings", {})
        with_strategy = with_settings.get("icebergCompaction", {}).get("strategy")

        # Table reported "with compaction" must have sort compaction enabled;
        # the other must have compaction disabled.
        return with_enabled and not without_enabled and with_strategy == "sort"
    except (ClientError, Exception):
        return False


def _get_bucket_arn():
    s3tables = boto3.client("s3tables", region_name=REGION)
    resp = s3tables.list_table_buckets()
    for b in resp.get("tableBuckets", []):
        if b["name"] == BUCKET_NAME:
            return b["arn"]
    return ""


def _get_namespace_for(bucket_arn, table_name):
    """Return the namespace string for a table, looked up by name.

    list_tables returns `namespace` as a list of strings (e.g. ["default"]);
    get_table_maintenance_configuration wants the string form.
    """
    if not bucket_arn:
        return ""
    s3tables = boto3.client("s3tables", region_name=REGION)
    for t in s3tables.list_tables(tableBucketARN=bucket_arn).get("tables", []):
        if t["name"] == table_name:
            ns = t.get("namespace")
            if isinstance(ns, list):
                return ns[0] if ns else ""
            return ns or ""
    return ""


@criterion(
    description="Exactly 2 S3 tables exist in the bucket (no extra tables created)"
)
def exactly_two_tables(workspace: Path) -> bool:
    if not BUCKET_NAME:
        return False
    try:
        bucket_arn = _get_bucket_arn()
        if not bucket_arn:
            return False
        s3tables = boto3.client("s3tables", region_name=REGION)
        resp = s3tables.list_tables(tableBucketARN=bucket_arn)
        tables = resp.get("tables", [])
        return len(tables) == 2
    except (ClientError, Exception):
        return False
