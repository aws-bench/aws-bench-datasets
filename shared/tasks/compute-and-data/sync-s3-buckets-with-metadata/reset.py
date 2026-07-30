"""Data-plane reset for sync-s3-buckets-with-metadata.

Re-seeds the source bucket with its baseline object and empties the
destination bucket. Config is read from the environment; returns a list of
error strings rather than raising.
"""

import os

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
SOURCE_BUCKET = os.environ.get("SYNC_SOURCE_BUCKET", "")
DESTINATION_BUCKET = os.environ.get("DESTINATION_BUCKET", "")

# Baseline objects re-seeded into the source bucket. Each carries an explicit
# Content-Type and Metadata map.
SOURCE_BASELINE_OBJECTS = [
    {
        "Key": "sample.txt",
        "Body": b"This is a sample text file content.\nCreated using CDK!",
        "ContentType": "text/plain",
        "Metadata": {},
    },
]


def _empty(s3, bucket: str, errors: list[str]) -> None:
    """Delete every object version and delete marker from a versioned bucket."""
    if not bucket:
        return
    try:
        # Paginator caps each page at 1000, so one delete_objects per page.
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


def _seed_source(s3, bucket: str, errors: list[str]) -> None:
    if not bucket:
        return
    for obj in SOURCE_BASELINE_OBJECTS:
        try:
            s3.put_object(
                Bucket=bucket,
                Key=obj["Key"],
                Body=obj["Body"],
                ContentType=obj["ContentType"],
                Metadata=obj["Metadata"],
            )
        except ClientError as e:
            errors.append(f"put {bucket}/{obj['Key']}: {e}")


def reset_data_plane(
    session: boto3.Session | None = None, region: str = REGION
) -> list[str]:
    """Reset both buckets to their baseline.

    Empties the source and destination buckets (object versions and delete
    markers) then re-seeds the source bucket, preserving each object's
    Content-Type and Metadata. Returns a list of error strings (empty on
    success). Never raises for a per-operation failure.
    """
    if session is None:
        session = boto3.Session(region_name=region)
    s3 = session.client("s3", region_name=region)
    errors: list[str] = []
    _empty(s3, SOURCE_BUCKET, errors)
    _empty(s3, DESTINATION_BUCKET, errors)
    _seed_source(s3, SOURCE_BUCKET, errors)
    return errors
