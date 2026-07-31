"""Data-plane reset for invalidate-cloudfront-cache.

Empties the CloudFront origin S3 bucket, then re-puts the three static pages
(index.html, page1.html, page2.html). Config from env; best-effort, returns a
list of error strings rather than raising.
"""

import mimetypes
import os

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
BUCKET_NAME = os.environ.get("CF_DATA_BUCKET", "")

# key -> object body for the three static pages.
OBJECTS: dict[str, str] = {
    "index.html": "<html><body><h1>CloudFront Test Page</h1><p>Version 1.0</p></body></html>",
    "page1.html": "<html><body><h1>Page 1</h1><p>Content for testing</p></body></html>",
    "page2.html": "<html><body><h1>Page 2</h1><p>More content</p></body></html>",
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
    """Empty the origin bucket, then re-put the seed objects. Idempotent.

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
