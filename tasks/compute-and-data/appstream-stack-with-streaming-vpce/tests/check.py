"""Programmatic verifier for appstream-stack-with-streaming-vpce.

Re-implements aws-bench-datasets/src/aws_bench_datasets/mutation_scripts/10d1f8d3-2a65-4c69-bfd6-8fdb1487373f/validate.py.

The agent creates an AppStream 2.0 stack and attaches a STREAMING access
endpoint pointing at a VPC endpoint. Verifier:
  1. confirms the named stack exists,
  2. confirms it has an AccessEndpoint with EndpointType=STREAMING and
     VpceId equal to the agent-reported VPCE ID.
"""

import json
import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    AGENT_OUTPUT = {}

REQUIRED_OUTPUT_KEYS = ("appstream_stack_name", "vpc_endpoint_id")
STACK_NAME = AGENT_OUTPUT.get("appstream_stack_name") or ""
VPCE_ID = AGENT_OUTPUT.get("vpc_endpoint_id") or ""


def _appstream():
    return boto3.client("appstream", region_name=REGION)


def _describe_stack() -> dict | None:
    if not STACK_NAME:
        return None
    try:
        resp = _appstream().describe_stacks(Names=[STACK_NAME])
    except ClientError:
        return None
    items = resp.get("Stacks") or []
    return items[0] if items else None


@criterion(description="agent wrote agent-output.json with all required keys")
def output_contract_followed(workspace: Path) -> bool:
    return bool(AGENT_OUTPUT) and all(k in AGENT_OUTPUT for k in REQUIRED_OUTPUT_KEYS)


@criterion(
    description="reported AppStream stack exists and has a STREAMING access endpoint pointing at the reported VPCE"
)
def stack_has_streaming_vpce(workspace: Path) -> bool:
    """Single criterion covering both legacy validations.

    Stack-existence and endpoint-attached are functionally one
    requirement: a stack with the wrong endpoint shape is just as
    broken as no stack. Per-property failure detail surfaces in
    verifier/test-stdout.txt.
    """
    if not VPCE_ID:
        return False
    stack = _describe_stack()
    if stack is None:
        return False
    for ep in stack.get("AccessEndpoints") or []:
        if ep.get("EndpointType") == "STREAMING" and ep.get("VpceId") == VPCE_ID:
            return True
    return False
