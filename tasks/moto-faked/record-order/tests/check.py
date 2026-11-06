"""Programmatic verifier for record-order.

Checks the agent's structured output contract AND the live DynamoDB state:
item ord-1001 must exist with exactly status PENDING and total 2500.

A no-op agent fails: the seed state holds no ord-1001 item.

Honors AWS_ENDPOINT_URL so it grades against moto or real AWS. In
publication rewardkit discovers the @criterion functions below; run as a
script it exits 0/1 for offline grading.
"""

import json
import os
import sys
from decimal import Decimal
from pathlib import Path

import boto3

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
TABLE_NAME = os.environ["EXPECTED_TABLE"]

ORDER_ID = "ord-1001"
EXPECTED_ITEM = {"orderId": ORDER_ID, "status": "PENDING", "total": Decimal("2500")}
REQUIRED_OUTPUT_KEYS = ("order_id", "status")

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, ValueError):
    AGENT_OUTPUT = {}


def _read_item():
    table = boto3.resource(
        "dynamodb", region_name=REGION, endpoint_url=ENDPOINT_URL
    ).Table(TABLE_NAME)
    return table.get_item(Key={"orderId": ORDER_ID}).get("Item")


@criterion(description="agent wrote agent-output.json with all required keys")
def output_contract_followed(workspace: Path) -> bool:
    return _output_contract_followed()


@criterion(description="ord-1001 recorded with status PENDING and total 2500")
def item_matches(workspace: Path) -> bool:
    return _read_item() == EXPECTED_ITEM


def _output_contract_followed() -> bool:
    return (
        bool(AGENT_OUTPUT)
        and all(k in AGENT_OUTPUT for k in REQUIRED_OUTPUT_KEYS)
        and AGENT_OUTPUT.get("order_id") == ORDER_ID
        and AGENT_OUTPUT.get("status") == "PENDING"
    )


if __name__ == "__main__":
    if _output_contract_followed() and _read_item() == EXPECTED_ITEM:
        print("PASS: ord-1001 recorded with status PENDING and total 2500")
        sys.exit(0)
    print("FAIL: ord-1001 missing, mismatched, or output contract broken")
    sys.exit(1)
