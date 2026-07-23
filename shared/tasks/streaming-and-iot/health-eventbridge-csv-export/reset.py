"""Reset script for health-eventbridge-csv-export task.

Wipes the export S3 bucket back to empty baseline state.

Usage:
    python reset.py
"""

import logging
import os

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.WARNING)

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")


# ============================================================
# S3 Clean
# ============================================================


def _wipe_bucket(s3_resource, bucket_name: str, errors: list[str]):
    """Delete all objects and versions from a bucket."""
    if not bucket_name:
        return
    try:
        bucket = s3_resource.Bucket(bucket_name)
        bucket.object_versions.delete()
        bucket.objects.delete()
        logger.warning("  ✓ Wiped: %s", bucket_name)
    except ClientError as e:
        if e.response["Error"]["Code"] == "NoSuchBucket":
            logger.warning("  [SKIP] Bucket doesn't exist: %s", bucket_name)
        else:
            errors.append(f"S3 wipe failed ({bucket_name}): {e}")
            logger.warning("  ✗ Wipe failed (%s): %s", bucket_name, e)


def reset_data_plane(
    session: boto3.Session | None = None, region: str = REGION
) -> list[str]:
    """Reset the data plane to baseline state (wipe export bucket).

    Returns a list of error strings (empty on success). Never raises for a
    per-resource failure.
    """
    if session is None:
        session = boto3.Session(region_name=region)

    errors: list[str] = []

    export_bucket = os.environ.get("EXPORT_BUCKET", "")

    logger.warning("=" * 60)
    logger.warning("Reset: health-eventbridge-csv-export")
    logger.warning("Region: %s", region)
    logger.warning("=" * 60)

    if not export_bucket:
        logger.warning("[SKIP] EXPORT_BUCKET env var not set")
        return errors

    logger.warning("\n--- Wipe export S3 bucket ---")
    s3_resource = session.resource("s3")
    logger.warning("[WIPE] %s", export_bucket)
    _wipe_bucket(s3_resource, export_bucket, errors)

    logger.warning("\n" + "=" * 60)
    if errors:
        logger.warning("Reset done with %d error(s).", len(errors))
    else:
        logger.warning("Reset done.")

    return errors
