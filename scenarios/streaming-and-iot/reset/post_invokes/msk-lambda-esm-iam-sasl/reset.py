"""Reset script for msk-lambda-esm-iam-sasl task.

Wipes all objects from the MSK sink bucket back to its empty baseline.

Usage:
    python reset.py
"""

import json
import logging
import os
import sys

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.WARNING)

REGION = os.environ.get("AWS_REGION", "us-east-1")


# ============================================================
# Clean: Wipe S3 sink bucket
# ============================================================


def _wipe_bucket(session: boto3.Session, bucket: str, errors: list[str]):
    """Delete all objects and versions from the sink bucket."""
    logger.warning("\n--- S3 sink bucket: %s ---", bucket)
    if not bucket:
        logger.warning("[SKIP] SINK_BUCKET_NAME not set")
        return
    try:
        s3_resource = session.resource("s3", region_name=REGION)
        b = s3_resource.Bucket(bucket)
        b.object_versions.delete()
        b.objects.delete()
        logger.warning("  ✓ Wiped all objects from %s", bucket)
    except ClientError as e:
        if e.response["Error"]["Code"] == "NoSuchBucket":
            logger.warning("  [SKIP] Bucket doesn't exist: %s", bucket)
        else:
            errors.append(f"wipe bucket {bucket}: {e}")
            logger.warning("  ✗ Wipe failed: %s", e)


def reset_data_plane(
    session: boto3.Session | None = None, region: str = REGION
) -> list[str]:
    """Wipe the MSK sink bucket to its empty baseline.

    Returns a list of error strings (empty on success). Never raises for a
    per-resource failure.
    """
    if session is None:
        session = boto3.Session(region_name=region)

    errors: list[str] = []

    sink_bucket = os.environ.get("SINK_BUCKET_NAME", "")

    # === CLEAN ===
    logger.warning("=" * 60)
    logger.warning("Reset: msk-lambda-esm-iam-sasl")
    logger.warning("Region: %s", region)
    logger.warning("=" * 60)

    _wipe_bucket(session, sink_bucket, errors)

    # No seed phase — baseline is empty.

    logger.warning("\n" + "=" * 60)
    if errors:
        logger.warning("Reset done with %d error(s).", len(errors))
    else:
        logger.warning("Reset done.")

    return errors
