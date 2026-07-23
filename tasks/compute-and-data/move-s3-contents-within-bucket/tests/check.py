"""Programmatic verifier for move-s3-contents-within-bucket.

The instruction gives the agent a WRONG source path ('sourc/') but the
actual files live at 'source/'. The agent must discover the real path,
move the files to 'destination/', and leave 'source/' empty.

Checks:
  1. The real source path ('source/') is empty — files were moved away
  2. The destination has the specific files that were in source/
"""

import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
BUCKET_NAME = os.environ.get("MOVE_DATA_BUCKET", "")
# The REAL source path where CDK deploys files (not the 'sourc/' typo)
REAL_SOURCE_PATH = "source/"
DESTINATION_PATH = os.environ.get("DESTINATION_PATH", "destination/")

# Files that the CDK seeds under source/
EXPECTED_FILES = ("file1.txt", "file2.json", "subfolder/file3.txt")


def _s3():
    return boto3.client("s3", region_name=REGION)


@criterion(description="Source path 'source/' is empty (files moved away)")
def source_path_empty(workspace: Path) -> bool:
    if not BUCKET_NAME:
        return False
    try:
        resp = _s3().list_objects_v2(Bucket=BUCKET_NAME, Prefix=REAL_SOURCE_PATH)
        return resp.get("KeyCount", 0) == 0
    except ClientError:
        return False


@criterion(description="All original source files exist under destination/")
def files_moved_to_destination(workspace: Path) -> bool:
    if not BUCKET_NAME or not DESTINATION_PATH:
        return False
    try:
        resp = _s3().list_objects_v2(
            Bucket=BUCKET_NAME, Prefix=DESTINATION_PATH, MaxKeys=100
        )
        dest_keys = {obj["Key"] for obj in resp.get("Contents", [])}
    except ClientError:
        return False

    # Check that each expected file appears in destination (with the destination prefix)
    for f in EXPECTED_FILES:
        expected_key = DESTINATION_PATH + f
        if expected_key not in dest_keys:
            return False
    return True
