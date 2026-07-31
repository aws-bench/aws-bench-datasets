"""Programmatic verifier for managed-ad-with-ldaps-and-resets.

Re-implements aws-bench-datasets/src/aws_bench_datasets/mutation_scripts/e2e29b17-725f-43b6-938f-ac67f6991e74/validate.py.

The agent creates a Microsoft AD directory and enables LDAPS on it, then
reports the directory ID via agent-output.json. Verifier confirms:
  1. the directory exists and is in `Active` state (poll up to ~5 min if
     still `Creating` — provisioning can extend past the agent timeout),
  2. LDAPS settings exist with status `Enabled`.
"""

import json
import os
import time
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_REGION", "us-east-1")

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    AGENT_OUTPUT = {}

REQUIRED_OUTPUT_KEYS = ("directory_id",)
DIRECTORY_ID = AGENT_OUTPUT.get("directory_id") or ""

# Bounded polling: AD can take 20-45 min; verifier won't outlast its own
# 360s timeout, so we poll for up to ~4 min and otherwise accept the
# terminal state we last observed. If still Creating when we exit, the
# agent didn't finish — failure.
ACTIVE_WAIT_SEC = 240
ACTIVE_POLL_SEC = 30


def _ds():
    return boto3.client("ds", region_name=REGION)


def _describe_directory() -> dict | None:
    try:
        resp = _ds().describe_directories(DirectoryIds=[DIRECTORY_ID])
    except ClientError:
        return None
    items = resp.get("DirectoryDescriptions") or []
    return items[0] if items else None


@criterion(description="agent wrote agent-output.json with all required keys")
def output_contract_followed(workspace: Path) -> bool:
    return bool(AGENT_OUTPUT) and all(k in AGENT_OUTPUT for k in REQUIRED_OUTPUT_KEYS)


@criterion(
    description="reported Microsoft AD directory exists and is Active (polls briefly if still Creating)"
)
def directory_active(workspace: Path) -> bool:
    if not DIRECTORY_ID:
        return False
    elapsed = 0
    while elapsed <= ACTIVE_WAIT_SEC:
        d = _describe_directory()
        if d is None:
            return False
        stage = d.get("Stage")
        if stage == "Active":
            return True
        if stage != "Creating":
            return False
        time.sleep(ACTIVE_POLL_SEC)
        elapsed += ACTIVE_POLL_SEC
    return False


@criterion(description="LDAPS is configured and Enabled on the directory")
def ldaps_enabled(workspace: Path) -> bool:
    if not DIRECTORY_ID:
        return False
    try:
        resp = _ds().describe_ldaps_settings(DirectoryId=DIRECTORY_ID)
    except ClientError:
        return False
    settings = resp.get("LDAPSSettingsInfo") or []
    if not settings:
        return False
    return settings[0].get("LDAPSStatus") == "Enabled"
