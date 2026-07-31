"""Rollback for transit-vpc-architecture.

Reads the ENI ID from /logs/agent/agent-output.json (the agent's
self-reported CrossENI), force-detaches if attached, then deletes.
Polls briefly for the detach to settle so the delete doesn't 409.

Best-effort: errors print to stderr but the script exits 0 so the
trial-end hook doesn't error out and block the next trial.
"""

import json
import os
import sys
import time
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")

DETACH_POLL_SEC = 2
DETACH_MAX_POLLS = 30


def _read_eni_id() -> str:
    try:
        return (
            json.loads(Path("/logs/agent/agent-output.json").read_text()).get(
                "CrossENI"
            )
            or ""
        )
    except (FileNotFoundError, json.JSONDecodeError):
        return ""


def main() -> int:
    eni_id = _read_eni_id()
    if not eni_id:
        return 0

    ec2 = boto3.client("ec2", region_name=REGION)
    errors: list[str] = []

    try:
        resp = ec2.describe_network_interfaces(NetworkInterfaceIds=[eni_id])
    except ClientError as e:
        if "InvalidNetworkInterfaceID.NotFound" in str(e):
            return 0
        errors.append(f"describe ENI: {e}")
        for err in errors:
            print(err, file=sys.stderr)
        return 0

    enis = resp.get("NetworkInterfaces") or []
    if not enis:
        return 0
    attachment = enis[0].get("Attachment") or {}
    attachment_id = attachment.get("AttachmentId")

    if attachment_id:
        try:
            ec2.detach_network_interface(AttachmentId=attachment_id, Force=True)
        except ClientError as e:
            errors.append(f"detach: {e}")
        for _ in range(DETACH_MAX_POLLS):
            time.sleep(DETACH_POLL_SEC)
            try:
                resp = ec2.describe_network_interfaces(NetworkInterfaceIds=[eni_id])
            except ClientError as e:
                if "InvalidNetworkInterfaceID.NotFound" in str(e):
                    return 0
                break
            if not (resp.get("NetworkInterfaces") or [{}])[0].get("Attachment"):
                break

    try:
        ec2.delete_network_interface(NetworkInterfaceId=eni_id)
    except ClientError as e:
        if "InvalidNetworkInterfaceID.NotFound" not in str(e):
            errors.append(f"delete: {e}")

    for err in errors:
        print(err, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
