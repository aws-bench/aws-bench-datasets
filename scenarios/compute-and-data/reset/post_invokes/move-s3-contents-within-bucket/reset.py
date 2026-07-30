"""Data-plane reset for move-s3-contents-within-bucket.

Empties the bucket, then re-puts the source-folder objects and the
destination-folder placeholder. Imported and called first by both
pre_invoke and post_invoke.
"""

import mimetypes
import os

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
BUCKET_NAME = os.environ.get("MOVE_DATA_BUCKET", "")

# key -> object body.
OBJECTS: dict[str, str] = {
    "source/file1.txt": "Sample content 1",
    "source/file2.json": '{"key": "value"}',
    "source/subfolder/file3.txt": "Nested content",
    "destination/placeholder.txt": "Ready",
}


def _empty(s3, bucket: str, errors: list[str]) -> None:
    """Delete every object version + delete marker (the bucket is versioned)."""
    try:
        paginator = s3.get_paginator("list_object_versions")
        for page in paginator.paginate(Bucket=bucket):
            to_delete = [
                {"Key": v["Key"], "VersionId": v["VersionId"]}
                for v in (page.get("Versions", []) + page.get("DeleteMarkers", []))
            ]
            if to_delete:
                s3.delete_objects(Bucket=bucket, Delete={"Objects": to_delete})
    except ClientError as e:
        errors.append(f"empty {bucket}: {e}")


def _put(s3, bucket: str, key: str, body: str, errors: list[str]) -> None:
    # Content-Type from the file extension
    ctype = mimetypes.guess_type(key)[0] or "application/octet-stream"
    try:
        s3.put_object(
            Bucket=bucket, Key=key, Body=body.encode("utf-8"), ContentType=ctype
        )
    except ClientError as e:
        errors.append(f"put {key}: {e}")


def reset_data_plane(
    session: "boto3.Session | None" = None, region: str = REGION
) -> list[str]:
    """Empty the bucket, then re-put the seed objects. Idempotent.

    Returns a list of error strings (empty on success); never raises for a
    per-object failure.
    """
    if not BUCKET_NAME:
        return []
    if session is None:
        session = boto3.Session(region_name=region)
    s3 = session.client("s3", region_name=region)
    errors: list[str] = []
    _empty(s3, BUCKET_NAME, errors)
    for key, body in OBJECTS.items():
        _put(s3, BUCKET_NAME, key, body, errors)
    return errors
