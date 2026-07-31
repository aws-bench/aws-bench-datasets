"""Programmatic verifier for athena-table-cloudfront-logs.

Re-implements aws-bench-datasets/src/aws_bench_datasets/mutation_scripts/d3322cf4-8423-524b-cg8c-c2c5875f7f74/validate.py.

The agent picks its own database and table name and reports them via
agent-output.json. Verifier looks the table up via Glue and confirms
its StorageDescriptor.Location references the CloudFront log bucket.
"""

import json
import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_REGION", "us-east-1")
LOG_BUCKET = os.environ["EXPECTED_LOG_BUCKET"]

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    AGENT_OUTPUT = {}

# Match the JSON fence in instruction.md exactly. CI guard:
# `shared/judge/scripts/sync.sh --check-output-contract`.
REQUIRED_OUTPUT_KEYS = ("athenaDatabaseName", "athenaTableName")

CHOSEN_DATABASE = AGENT_OUTPUT.get("athenaDatabaseName") or ""
CHOSEN_TABLE = AGENT_OUTPUT.get("athenaTableName") or ""


def _glue():
    return boto3.client("glue", region_name=REGION)


@criterion(description="agent wrote agent-output.json with all required keys")
def output_contract_followed(workspace: Path) -> bool:
    """Diagnostic — runs first so a missing/malformed file shows clearly.

    Other criteria still guard on empty CHOSEN_* values; this just makes
    the failure mode legible on the score sheet.
    """
    return bool(AGENT_OUTPUT) and all(k in AGENT_OUTPUT for k in REQUIRED_OUTPUT_KEYS)


@criterion(
    description="agent's reported Athena database/table exist and the table location is the CloudFront log bucket root"
)
def athena_table_points_at_log_bucket(workspace: Path) -> bool:
    if not CHOSEN_DATABASE or not CHOSEN_TABLE:
        return False
    try:
        resp = _glue().get_table(DatabaseName=CHOSEN_DATABASE, Name=CHOSEN_TABLE)
    except ClientError:
        return False
    location = (
        (resp.get("Table") or {}).get("StorageDescriptor", {}).get("Location", "")
    )
    expected_prefix = f"s3://{LOG_BUCKET}/"
    return location.startswith(expected_prefix)


# CloudFront standard access log has 33 fields. We check a core subset
# that any correct schema must include (agents may use different naming
# conventions like hyphens vs underscores, so we normalize to lowercase
# with underscores before comparing).
REQUIRED_CLOUDFRONT_COLUMNS = {
    "date",
    "time",
    "c_ip",
    "cs_method",
    "cs_uri_stem",
    "sc_status",
    "sc_bytes",
    "cs_protocol",
    "cs_bytes",
    "time_taken",
    "x_edge_location",
    "x_edge_result_type",
}


def _normalize_col(name: str) -> str:
    """Normalize column name: lowercase, replace hyphens/spaces with underscores."""
    return name.lower().replace("-", "_").replace(" ", "_")


@criterion(description="table schema contains core CloudFront log columns")
def table_has_cloudfront_columns(workspace: Path) -> bool:
    if not CHOSEN_DATABASE or not CHOSEN_TABLE:
        return False
    try:
        resp = _glue().get_table(DatabaseName=CHOSEN_DATABASE, Name=CHOSEN_TABLE)
    except ClientError:
        return False
    columns = resp.get("Table", {}).get("StorageDescriptor", {}).get("Columns", [])
    col_names = {_normalize_col(c["Name"]) for c in columns}
    return REQUIRED_CLOUDFRONT_COLUMNS.issubset(col_names)
