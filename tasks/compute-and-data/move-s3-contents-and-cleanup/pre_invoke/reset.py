"""Data-plane reset for move-s3-contents-and-cleanup.

Empties the seeded versioned bucket and re-puts every baseline object under
the source (sourc/) and destination (source/) prefixes. Best-effort: returns
a list of error strings rather than raising.
"""

import mimetypes
import os

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
SOURCE_PATH = os.environ.get("SOURCE_PATH", "")
DEST_PATH = os.environ.get("DEST_PATH", "")

# Baseline objects for the source prefix (sourc/), keyed relative to it.
SOURCE_OBJECTS: dict[str, str] = {
    "config/config.json": '{"env":"prod","version":"1.0"}',
    "config/data.csv": "id,name,value\n1,test,100\n2,prod,200",
    "config/readme.md": "# Old Configuration\nThis is outdated",
    "logs/app.log": "[2024-01-01] Application started\n[2024-01-01] Processing data",
    "logs/error.log": "[2024-01-01] ERROR: Connection failed",
    "logs/metrics.json": '{"cpu":80,"memory":60}',
    "database/backup.sql": "CREATE TABLE users (id INT, name VARCHAR(50));",
    "database/schema.xml": '<?xml version="1.0"?><schema><table>users</table></schema>',
    "temp/temp.txt": "temporary file",
    "temp/old_backup.zip": "fake zip content",
    "archive/legacy.dat": "legacy data format",
    "archive/archive.tar": "archived files",
}

# Baseline objects for the destination prefix (source/), keyed relative to
# it: the .gitkeep marker plus six pre-2024 files.
DEST_OBJECTS: dict[str, str] = {
    ".gitkeep": "",
    "old_config_2022.json": '{"env":"old","version":"0.5","created":"2022-06-15"}',
    "legacy_data_2023.csv": "id,old_name,old_value\n1,legacy,50",
    "deprecated_2023.log": "[2023-03-01] This file is deprecated",
    "old/archive_2022.zip": "old archive from 2022",
    "old/backup_2023_01.sql": "CREATE TABLE old_users (id INT);",
    "old/temp_2023.tmp": "temporary file from last year",
}


def _parse_s3_path(s3_path: str) -> tuple[str, str]:
    """Return (bucket, prefix) for an s3://bucket/prefix path.

    The prefix is normalized to end with a single trailing slash so object
    keys can be built by simple concatenation.
    """
    path = s3_path.replace("s3://", "")
    if "/" not in path:
        return path, ""
    bucket, prefix = path.split("/", 1)
    if prefix and not prefix.endswith("/"):
        prefix += "/"
    return bucket, prefix


def _content_type(key: str) -> str:
    guessed, _ = mimetypes.guess_type(key)
    return guessed or "application/octet-stream"


def _empty(s3, bucket: str, errors: list[str]) -> None:
    """Delete every object version and delete-marker in a bucket.

    list_object_versions works on non-versioned buckets too (null VersionId)
    and the paginator caps each page at 1000, so no manual batching is needed.
    """
    try:
        paginator = s3.get_paginator("list_object_versions")
        for page in paginator.paginate(Bucket=bucket):
            to_delete = [
                {"Key": v["Key"], "VersionId": v["VersionId"]}
                for v in page.get("Versions", []) + page.get("DeleteMarkers", [])
            ]
            if to_delete:
                s3.delete_objects(Bucket=bucket, Delete={"Objects": to_delete})
    except ClientError as e:
        errors.append(f"empty {bucket}: {e}")


def _put(s3, bucket: str, key: str, content: str, errors: list[str]) -> None:
    try:
        s3.put_object(
            Bucket=bucket,
            Key=key,
            Body=content.encode("utf-8"),
            ContentType=_content_type(key),
        )
    except ClientError as e:
        errors.append(f"put s3://{bucket}/{key}: {e}")


def reset_data_plane(
    session: boto3.Session | None = None, region: str = REGION
) -> list[str]:
    """Restore the seeded bucket to its baseline.

    Empties the bucket (all versions + delete-markers when versioned) then
    re-puts every baseline object under both the source (sourc/) and
    destination (source/) prefixes. Returns a list of error strings (empty on
    success). Never raises for a per-operation failure.
    """
    if session is None:
        session = boto3.Session(region_name=region)
    s3 = session.client("s3", region_name=region)
    errors: list[str] = []

    if not SOURCE_PATH or not DEST_PATH:
        return []

    source_bucket, source_prefix = _parse_s3_path(SOURCE_PATH)
    dest_bucket, dest_prefix = _parse_s3_path(DEST_PATH)

    # Empty every distinct seeded bucket once before re-seeding.
    for bucket in dict.fromkeys([source_bucket, dest_bucket]):
        if bucket:
            _empty(s3, bucket, errors)

    for rel_key, content in SOURCE_OBJECTS.items():
        _put(s3, source_bucket, f"{source_prefix}{rel_key}", content, errors)
    for rel_key, content in DEST_OBJECTS.items():
        _put(s3, dest_bucket, f"{dest_prefix}{rel_key}", content, errors)

    return errors
