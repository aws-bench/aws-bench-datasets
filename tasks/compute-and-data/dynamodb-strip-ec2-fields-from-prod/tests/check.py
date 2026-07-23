"""Programmatic verifier for dynamodb-strip-ec2-fields-from-prod.

Re-implements aws-bench-datasets/src/aws_bench_datasets/mutation_scripts/0a211be3-7312-413a-bf7b-b1b4764e6e63/validate.py.

The agent must remove `ec2_instance_id` and `ec2_instance_type` from a
fixed list of production records seeded into the DynamoDB table. Other
seeded attributes (name, environment, created_by) must remain intact —
otherwise the agent could pass by deleting the records entirely.
"""

import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
TABLE_NAME = os.environ["EXPECTED_TABLE"]

# Targeted production records seeded by the scenario stack. Same list as
# the legacy validate.py / rollback.py — record_ids parameter in the JSONL.
TARGET_RECORD_IDS = (
    "PROD-EC2-015",
    "PROD-EC2-027",
    "PROD-EC2-041",
    "PROD-EC2-063",
    "PROD-EC2-078",
    "PROD-EC2-084",
    "PROD-EC2-091",
)
EC2_FIELDS = ("ec2_instance_id", "ec2_instance_type")
PRESERVED_FIELDS = ("name", "environment", "created_by")


def _table():
    return boto3.resource("dynamodb", region_name=REGION).Table(TABLE_NAME)


def _get_item(record_id: str) -> dict | None:
    try:
        resp = _table().get_item(Key={"id": record_id})
    except ClientError:
        return None
    return resp.get("Item")


@criterion(
    description="all targeted PROD-EC2-* records: ec2_instance_id/type stripped, name/environment/created_by preserved"
)
def ec2_fields_removed(workspace: Path) -> bool:
    """Single criterion covering the surgical-mutation contract.

    Two sub-checks short-circuit inline:
      1. Both ec2_* fields are absent or empty on every target record.
      2. The other seeded attributes are still present and non-empty,
         so the agent can't pass by deleting the records.
    Detailed per-record reasoning surfaces in verifier/test-stdout.txt.
    """
    for rid in TARGET_RECORD_IDS:
        item = _get_item(rid)
        if item is None:
            return False
        for f in EC2_FIELDS:
            if item.get(f) not in (None, ""):
                return False
        for f in PRESERVED_FIELDS:
            if not item.get(f):
                return False
    return True
