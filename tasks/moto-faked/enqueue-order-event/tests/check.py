"""Programmatic verifier for enqueue-order-event.

Checks the agent's structured output contract AND the live SQS state: the
queue must hold a message with the exact confirmation body and the orderId
routing attribute.

A no-op agent fails: the seed state leaves the queue empty.

Honors AWS_ENDPOINT_URL so it grades against moto or real AWS. In
publication rewardkit discovers the @criterion functions below; run as a
script it exits 0/1 for offline grading.
"""

import json
import os
import sys
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
QUEUE_URL = os.environ["EXPECTED_QUEUE_URL"]

EXPECTED_BODY = {"orderId": "ord-1001", "action": "CONFIRM"}
EXPECTED_ATTR = "ord-1001"
REQUIRED_OUTPUT_KEYS = ("message_id", "order_id")

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    AGENT_OUTPUT = {}


def _find_confirmation() -> bool:
    sqs = boto3.client("sqs", region_name=REGION, endpoint_url=ENDPOINT_URL)
    messages: list = []
    for _ in range(10):
        # VisibilityTimeout=0 keeps the message visible so the verifier is
        # re-runnable without mutating queue state.
        resp = sqs.receive_message(
            QueueUrl=QUEUE_URL,
            MaxNumberOfMessages=10,
            MessageAttributeNames=["All"],
            VisibilityTimeout=0,
        )
        batch = resp.get("Messages", [])
        if not batch:
            break
        messages.extend(batch)

    for msg in messages:
        try:
            body = json.loads(msg["Body"])
        except (json.JSONDecodeError, KeyError):
            continue
        attrs = msg.get("MessageAttributes", {})
        if (
            body == EXPECTED_BODY
            and attrs.get("orderId", {}).get("StringValue") == EXPECTED_ATTR
        ):
            return True
    return False


@criterion(description="agent wrote agent-output.json with all required keys")
def output_contract_followed(workspace: Path) -> bool:
    return (
        bool(AGENT_OUTPUT)
        and all(k in AGENT_OUTPUT for k in REQUIRED_OUTPUT_KEYS)
        and AGENT_OUTPUT.get("order_id") == EXPECTED_ATTR
        and bool(AGENT_OUTPUT.get("message_id"))
    )


@criterion(
    description="queue holds the confirmation event with orderId routing attribute"
)
def confirmation_event_present(workspace: Path) -> bool:
    return _find_confirmation()


def _output_contract_followed() -> bool:
    return (
        bool(AGENT_OUTPUT)
        and all(k in AGENT_OUTPUT for k in REQUIRED_OUTPUT_KEYS)
        and AGENT_OUTPUT.get("order_id") == EXPECTED_ATTR
        and bool(AGENT_OUTPUT.get("message_id"))
    )


if __name__ == "__main__":
    if _output_contract_followed() and _find_confirmation():
        print("PASS: confirmation event present with orderId routing attribute")
        sys.exit(0)
    print("FAIL: confirmation event missing from queue or output contract broken")
    sys.exit(1)
