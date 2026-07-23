"""Rollback for create-s3-bucket-with-config.

Deletes the bucket created by the agent (if any).
Best-effort: errors print to stderr but exit 0.
"""

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

    # Read bucket name from agent output
    bucket_name = ""
    if AGENT_OUTPUT_PATH.exists():
        try:
            data = json.loads(AGENT_OUTPUT_PATH.read_text())
            bucket_name = data.get("S3BucketName", "")
        except (json.JSONDecodeError, OSError):
            pass

    if not bucket_name:
        print("No bucket name found in agent output — nothing to clean up.")
        return 0

    s3 = boto3.client("s3", region_name=REGION)

    # Delete all objects (including versions) then the bucket
    try:
        # Delete all object versions
        paginator = s3.get_paginator("list_object_versions")
        for page in paginator.paginate(Bucket=bucket_name):
            objects = []
            for v in page.get("Versions", []):
                objects.append({"Key": v["Key"], "VersionId": v["VersionId"]})
            for dm in page.get("DeleteMarkers", []):
                objects.append({"Key": dm["Key"], "VersionId": dm["VersionId"]})
            if objects:
                s3.delete_objects(Bucket=bucket_name, Delete={"Objects": objects})

        s3.delete_bucket(Bucket=bucket_name)
        print(f"Deleted bucket: {bucket_name}")
    except ClientError as e:
        errors.append(f"Failed to delete bucket {bucket_name}: {e}")

    for err in errors:
        print(err, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
