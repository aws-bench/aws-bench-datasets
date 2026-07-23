"""Programmatic verifier for invalidate-cloudfront-cache.

Checks that the agent created a CloudFront invalidation for /* on the distribution.
"""

import json
import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
DISTRIBUTION_ID = os.environ.get("DISTRIBUTION_ID", "")

AGENT_OUTPUT_PATH = Path("/logs/agent/agent-output.json")
AGENT_OUTPUT: dict = {}
if AGENT_OUTPUT_PATH.exists():
    try:
        AGENT_OUTPUT = json.loads(AGENT_OUTPUT_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        pass

INVALIDATION_ID = AGENT_OUTPUT.get("InvalidationID", "")


@criterion(description="Agent wrote output.json with InvalidationID")
def output_contract_followed(workspace: Path) -> bool:
    return bool(INVALIDATION_ID)


@criterion(description="Invalidation exists on the distribution")
def invalidation_exists(workspace: Path) -> bool:
    if not DISTRIBUTION_ID or not INVALIDATION_ID:
        return False
    try:
        cf = boto3.client("cloudfront")
        resp = cf.get_invalidation(
            DistributionId=DISTRIBUTION_ID,
            Id=INVALIDATION_ID,
        )
        return resp["Invalidation"]["Id"] == INVALIDATION_ID
    except ClientError:
        return False


@criterion(description="Invalidation covers /* path")
def invalidation_covers_all_content(workspace: Path) -> bool:
    if not DISTRIBUTION_ID or not INVALIDATION_ID:
        return False
    try:
        cf = boto3.client("cloudfront")
        resp = cf.get_invalidation(
            DistributionId=DISTRIBUTION_ID,
            Id=INVALIDATION_ID,
        )
        paths = resp["Invalidation"]["InvalidationBatch"]["Paths"]["Items"]
        return "/*" in paths
    except ClientError:
        return False
