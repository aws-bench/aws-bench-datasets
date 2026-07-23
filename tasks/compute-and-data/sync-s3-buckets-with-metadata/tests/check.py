"""Programmatic verifier for sync-s3-buckets-with-metadata.

Checks that files were synced from source to destination bucket
with bucket-owner-full-control ACL.
"""

import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
SOURCE_BUCKET = os.environ.get("SYNC_SOURCE_BUCKET", "")
DESTINATION_BUCKET = os.environ.get("DESTINATION_BUCKET", "")


@criterion(description="Files synced from source to destination bucket")
def files_synced(workspace: Path) -> bool:
    s3 = boto3.client("s3", region_name=REGION)
    src_resp = s3.list_objects_v2(Bucket=SOURCE_BUCKET)
    dst_resp = s3.list_objects_v2(Bucket=DESTINATION_BUCKET)
    src_keys = {o["Key"] for o in src_resp.get("Contents", [])}
    dst_keys = {o["Key"] for o in dst_resp.get("Contents", [])}
    if not src_keys:
        return False
    return src_keys.issubset(dst_keys)


@criterion(description="Bucket owner has full control ACL on synced objects")
def acl_bucket_owner_full_control(workspace: Path) -> bool:
    s3 = boto3.client("s3", region_name=REGION)
    resp = s3.list_objects_v2(Bucket=DESTINATION_BUCKET)
    objects = resp.get("Contents", [])
    if not objects:
        return False
    obj_key = objects[0]["Key"]
    try:
        acl = s3.get_object_acl(Bucket=DESTINATION_BUCKET, Key=obj_key)
        owner_id = acl.get("Owner", {}).get("ID", "")
        return any(
            g.get("Grantee", {}).get("ID") == owner_id
            and g.get("Permission") == "FULL_CONTROL"
            for g in acl.get("Grants", [])
        )
    except ClientError:
        return False


@criterion(description="Every synced object has metadata 'migrated=true'")
def metadata_replaced(workspace: Path) -> bool:
    if not DESTINATION_BUCKET:
        return False
    try:
        s3 = boto3.client("s3", region_name=REGION)
        objects = s3.list_objects_v2(Bucket=DESTINATION_BUCKET).get("Contents", [])
        if not objects:
            return False
        for obj in objects:
            head = s3.head_object(Bucket=DESTINATION_BUCKET, Key=obj["Key"])
            if head.get("Metadata", {}).get("migrated") != "true":
                return False
        return True
    except ClientError:
        return False
