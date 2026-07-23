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

CHANNEL_ID = AGENT_OUTPUT.get("ChannelId", "")


@criterion(description="Agent wrote output.json with ChannelId")
def output_contract(workspace: Path) -> bool:
    return bool(CHANNEL_ID)


@criterion(description="MediaLive channel exists")
def channel_exists(workspace: Path) -> bool:
    if not CHANNEL_ID:
        return False
    try:
        client = boto3.client("medialive", region_name=REGION)
        client.describe_channel(ChannelId=CHANNEL_ID)
        return True
    except ClientError:
        return False


@criterion(description="Channel has input attachments and destinations configured")
def channel_configured(workspace: Path) -> bool:
    if not CHANNEL_ID:
        return False
    try:
        client = boto3.client("medialive", region_name=REGION)
        resp = client.describe_channel(ChannelId=CHANNEL_ID)
        has_inputs = len(resp.get("InputAttachments", [])) > 0
        has_destinations = len(resp.get("Destinations", [])) > 0
        return has_inputs and has_destinations
    except ClientError:
        return False
