"""Programmatic verifier for move-s3-contents-and-cleanup.

Checks:
1. Source path is empty (files moved away)
2. Destination has the expected files
3. Old files (2022/2023 in name) were removed from destination
"""

import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_REGION", "us-east-1")
SOURCE_PATH = os.environ.get("SOURCE_PATH", "")
DEST_PATH = os.environ.get("DEST_PATH", "")


def _parse_s3_path(s3_path: str) -> tuple[str, str]:
    path = s3_path.replace("s3://", "")
    if "/" not in path:
        return path, ""
    parts = path.split("/", 1)
    prefix = parts[1] if len(parts) > 1 else ""
    if prefix and not prefix.endswith("/"):
        prefix += "/"
    return parts[0], prefix


def _list_objects(bucket: str, prefix: str) -> list[str]:
    s3 = boto3.client("s3", region_name=REGION)
    keys = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            keys.append(obj["Key"])
    return keys


@criterion(description="Source path is empty after move")
def source_is_empty(workspace: Path) -> bool:
    if not SOURCE_PATH:
        return False
    try:
        bucket, prefix = _parse_s3_path(SOURCE_PATH)
        keys = _list_objects(bucket, prefix)
        return len(keys) == 0
    except ClientError:
        return False


@criterion(description="Destination has files")
def destination_has_files(workspace: Path) -> bool:
    if not DEST_PATH:
        return False
    try:
        bucket, prefix = _parse_s3_path(DEST_PATH)
        keys = _list_objects(bucket, prefix)
        return len(keys) > 0
    except ClientError:
        return False


@criterion(description="No old files (2022/2023) remain in destination")
def old_files_removed(workspace: Path) -> bool:
    if not DEST_PATH:
        return False
    try:
        bucket, prefix = _parse_s3_path(DEST_PATH)
        keys = _list_objects(bucket, prefix)
        old_files = [k for k in keys if "2022" in k or "2023" in k]
        return len(old_files) == 0
    except ClientError:
        return False
