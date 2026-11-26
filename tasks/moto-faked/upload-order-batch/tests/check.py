"""Programmatic verifier for upload-order-batch.

Checks the agent's structured output contract AND the live S3 state:
the batch key must exist and hold exactly the two required orders.

A no-op agent (no output files, no upload) fails: the seed state leaves
`incoming/` empty.

Honors AWS_ENDPOINT_URL so it grades against moto or real AWS. In
publication rewardkit discovers the @criterion functions below; run as a
script it exits 0/1 for offline grading.
"""

import json
import os
import sys
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

try:
    from rewardkit import criterion
except ImportError:  # offline grading without harbor-rewardkit installed

    def criterion(*dargs, **dkwargs):
        def wrap(fn):
            return fn

        if dargs and callable(dargs[0]):
            return dargs[0]
        return wrap


REGION = os.environ.get("AWS_REGION", "us-east-1")
ENDPOINT_URL = os.environ.get("AWS_ENDPOINT_URL") or None
BUCKET_NAME = os.environ["EXPECTED_BUCKET"]

BATCH_KEY = "incoming/orders-2026-10-23.json"
EXPECTED_ORDERS = [
    {"orderId": "ord-1001", "total": 2500, "currency": "USD"},
    {"orderId": "ord-1002", "total": 1750, "currency": "USD"},
]

REQUIRED_OUTPUT_KEYS = ("s3_key", "order_count")

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    AGENT_OUTPUT = {}


def _read_batch():
    s3 = boto3.client("s3", region_name=REGION, endpoint_url=ENDPOINT_URL)
    try:
        body = (
            s3.get_object(Bucket=BUCKET_NAME, Key=BATCH_KEY)["Body"]
            .read()
            .decode("utf-8")
        )
    except ClientError:
        return None
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return None


@criterion(description="agent wrote agent-output.json with all required keys")
def output_contract_followed(workspace: Path) -> bool:
    return _output_contract_followed()


@criterion(description="batch key holds exactly the two required orders")
def batch_content_matches(workspace: Path) -> bool:
    return _batch_content_matches()


def _output_contract_followed() -> bool:
    return bool(AGENT_OUTPUT) and all(k in AGENT_OUTPUT for k in REQUIRED_OUTPUT_KEYS)


def _batch_content_matches() -> bool:
    if AGENT_OUTPUT.get("s3_key") != BATCH_KEY:
        return False
    if AGENT_OUTPUT.get("order_count") != len(EXPECTED_ORDERS):
        return False
    return _read_batch() == EXPECTED_ORDERS


if __name__ == "__main__":
    if _batch_content_matches() and _output_contract_followed():
        print("PASS: batch uploaded with exactly the two required orders")
        sys.exit(0)
    print("FAIL: batch key missing, unreadable, or content mismatch")
    sys.exit(1)
