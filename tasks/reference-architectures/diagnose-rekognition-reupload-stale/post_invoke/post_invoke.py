"""Post-invoke for diagnose-rekognition-reupload-stale.

Deletes the alpha.jpg object and its table row so the account returns to the
empty-bucket, empty-table baseline the setup snapshot captured.

Deleting the object re-triggers the notification only for ObjectCreated, so this
cleanup does not invoke the handler again. Log events from the trial are left in
place: CloudWatch Logs retention owns them and the next pre-invoke scopes its
search by timestamp.

Idempotent: an absent object, an absent row, and a torn-down stack are all
treated as already clean.

Env vars (from ``[post_invoke.env]`` in task.toml):
    BUCKET_NAME  Bucket to clear.
    TABLE_NAME   Table to clear.
    AWS_REGION   Region the stack lives in.
"""

import logging
import os
import sys

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

OBJECT_KEY = "alpha.jpg"

# Errors meaning the resource is already gone, so cleanup has nothing to do.
GONE_CODES = ("NoSuchBucket", "NoSuchKey", "ResourceNotFoundException")


def run() -> None:
    bucket = os.environ["BUCKET_NAME"]
    table = os.environ["TABLE_NAME"]
    region = os.environ["AWS_REGION"]

    s3 = boto3.client("s3", region_name=region)
    ddb = boto3.client("dynamodb", region_name=region)

    try:
        s3.delete_object(Bucket=bucket, Key=OBJECT_KEY)
        logger.info(f"deleted s3://{bucket}/{OBJECT_KEY}")
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") not in GONE_CODES:
            raise
        logger.info(f"s3://{bucket}/{OBJECT_KEY} already absent")

    try:
        ddb.delete_item(TableName=table, Key={"image_name": {"S": OBJECT_KEY}})
        logger.info(f"deleted {table} row for {OBJECT_KEY}")
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") not in GONE_CODES:
            raise
        logger.info(f"{table} already absent")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    try:
        run()
    except (ClientError, KeyError) as e:
        print(f"post_invoke failed: {e}", file=sys.stderr)
        sys.exit(1)
