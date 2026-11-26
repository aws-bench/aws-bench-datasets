"""Data-plane seed/reset for upload-order-batch.

Baseline: the `incoming/` prefix is empty (the batch key the task asks for
does not exist), so a no-op agent fails the verifier. Imported and called
first by both pre_invoke and post_invoke; idempotent and safe to retry.
"""

import os

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
ENDPOINT_URL = os.environ.get("AWS_ENDPOINT_URL") or None
BUCKET_NAME = os.environ.get("LANDING_BUCKET", "")

PREFIX = "incoming/"


def reset_data_plane(session=None, region: str = REGION) -> list:
    errors: list = []
    if not BUCKET_NAME:
        return ["LANDING_BUCKET is not set"]
    s3 = (session or boto3.Session()).client(
        "s3", region_name=region, endpoint_url=ENDPOINT_URL
    )
    try:
        paginator = s3.get_paginator("list_objects_v2")
        keys = [
            obj["Key"]
            for page in paginator.paginate(Bucket=BUCKET_NAME, Prefix=PREFIX)
            for obj in page.get("Contents", [])
        ]
        for key in keys:
            try:
                s3.delete_object(Bucket=BUCKET_NAME, Key=key)
            except ClientError as e:
                errors.append(f"delete {key}: {e}")
    except ClientError as e:
        errors.append(f"list {PREFIX}: {e}")
    return errors
