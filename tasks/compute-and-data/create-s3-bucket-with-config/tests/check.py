"""Programmatic verifier for create-s3-bucket-with-config.

Checks that the agent created an S3 bucket with:
- Public access blocked
- AES-256 server-side encryption
- Versioning enabled
- Tags: Environment=Testing, Purpose=AIOperations, Owner=AITeam, Project=AITesting
"""

import json
import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

# ── Inputs ───────────────────────────────────────────────────────────────────

REGION = os.environ.get("AWS_REGION", "us-east-1")

AGENT_OUTPUT_PATH = Path("/logs/agent/agent-output.json")
AGENT_OUTPUT: dict = {}
if AGENT_OUTPUT_PATH.exists():
    try:
        AGENT_OUTPUT = json.loads(AGENT_OUTPUT_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        pass

BUCKET_NAME = AGENT_OUTPUT.get("S3BucketName", "")


# ── Criteria ─────────────────────────────────────────────────────────────────


@criterion(description="Agent wrote output.json with S3BucketName")
def output_contract_followed(workspace: Path) -> bool:
    return bool(BUCKET_NAME)


@criterion(description="Bucket exists in the account")
def bucket_exists(workspace: Path) -> bool:
    try:
        s3 = boto3.client("s3", region_name=REGION)
        s3.head_bucket(Bucket=BUCKET_NAME)
        return True
    except ClientError:
        return False


@criterion(description="All public access is blocked")
def public_access_blocked(workspace: Path) -> bool:
    try:
        s3 = boto3.client("s3", region_name=REGION)
        resp = s3.get_public_access_block(Bucket=BUCKET_NAME)
        config = resp["PublicAccessBlockConfiguration"]
        return all(
            [
                config.get("BlockPublicAcls", False),
                config.get("IgnorePublicAcls", False),
                config.get("BlockPublicPolicy", False),
                config.get("RestrictPublicBuckets", False),
            ]
        )
    except ClientError:
        return False


@criterion(description="AES-256 default encryption enabled")
def encryption_aes256(workspace: Path) -> bool:
    try:
        s3 = boto3.client("s3", region_name=REGION)
        resp = s3.get_bucket_encryption(Bucket=BUCKET_NAME)
        rules = resp["ServerSideEncryptionConfiguration"]["Rules"]
        for rule in rules:
            algo = rule.get("ApplyServerSideEncryptionByDefault", {}).get(
                "SSEAlgorithm", ""
            )
            if algo == "AES256":
                return True
        return False
    except ClientError:
        return False


@criterion(description="Versioning enabled")
def versioning_enabled(workspace: Path) -> bool:
    try:
        s3 = boto3.client("s3", region_name=REGION)
        resp = s3.get_bucket_versioning(Bucket=BUCKET_NAME)
        return resp.get("Status") == "Enabled"
    except ClientError:
        return False


@criterion(description="Required tags present")
def tags_correct(workspace: Path) -> bool:
    expected = {
        "Environment": "Testing",
        "Purpose": "AIOperations",
        "Owner": "AITeam",
        "Project": "AITesting",
    }
    try:
        s3 = boto3.client("s3", region_name=REGION)
        resp = s3.get_bucket_tagging(Bucket=BUCKET_NAME)
        tags = {t["Key"]: t["Value"] for t in resp.get("TagSet", [])}
        return all(tags.get(k) == v for k, v in expected.items())
    except ClientError:
        return False
