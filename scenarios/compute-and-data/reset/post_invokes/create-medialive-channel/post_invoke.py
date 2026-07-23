import json
import os
import sys
from pathlib import Path

AGENT_OUTPUT_PATH = Path("/logs/agent/agent-output.json")

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")


def main() -> int:
    errors: list[str] = []

    channel_id = ""
    if AGENT_OUTPUT_PATH.exists():
        try:
            data = json.loads(AGENT_OUTPUT_PATH.read_text())
            channel_id = data.get("ChannelId", "")
        except (json.JSONDecodeError, OSError):
            pass

    if not channel_id:
        print("No ChannelId found in agent output — nothing to clean up.")
        return 0

    client = boto3.client("medialive", region_name=REGION)

    # Get channel details to find associated inputs
    input_ids = []
    try:
        resp = client.describe_channel(ChannelId=channel_id)
        for attachment in resp.get("InputAttachments", []):
            input_id = attachment.get("InputId")
            if input_id:
                input_ids.append(input_id)
    except ClientError as e:
        errors.append(f"Failed to describe channel: {e}")

    # Stop channel if running
    try:
        resp = client.describe_channel(ChannelId=channel_id)
        if resp.get("State") in ("RUNNING", "STARTING"):
            client.stop_channel(ChannelId=channel_id)
            import time

            time.sleep(30)
    except ClientError:
        pass

    # Delete channel
    try:
        client.delete_channel(ChannelId=channel_id)
        # Wait for channel to be fully deleted before removing inputs
        waiter = client.get_waiter("channel_deleted")
        waiter.wait(ChannelId=channel_id)
        print(f"Deleted channel: {channel_id}")
    except ClientError as e:
        errors.append(f"Failed to delete channel: {e}")

    # Delete inputs
    for input_id in input_ids:
        try:
            client.delete_input(InputId=input_id)
            print(f"Deleted input: {input_id}")
        except ClientError as e:
            errors.append(f"Failed to delete input {input_id}: {e}")

    for err in errors:
        print(err, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
