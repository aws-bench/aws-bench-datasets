"""Reset script for s3-csv-to-xlsx-lambda-pipeline task.

Wipes the entire ETL bucket, clears notification config, then re-seeds
with baseline CSVs.

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

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")


# ============================================================
# Clean: Wipe entire bucket
# ============================================================


def _wipe_bucket(s3, s3_resource, bucket: str, errors: list[str]):
    """Delete all objects and versions from the bucket."""
    if not bucket:
        return
    logger.warning("\n--- Wipe bucket: %s ---", bucket)
    try:
        b = s3_resource.Bucket(bucket)
        b.object_versions.delete()
        b.objects.delete()
        logger.warning("  ✓ Wiped all objects from %s", bucket)
    except ClientError as e:
        if e.response["Error"]["Code"] == "NoSuchBucket":
            errors.append(f"Bucket doesn't exist: {bucket}")
            logger.warning("  [SKIP] Bucket doesn't exist: %s", bucket)
        else:
            errors.append(f"Wipe bucket {bucket} failed: {e}")
            logger.warning("  ✗ Wipe failed: %s", e)


# ============================================================
# Seed: re-upload baseline CSVs (matching CDK BucketDeployment)
# ============================================================


def _seed_etl_bucket(s3, bucket: str, errors: list[str]):
    """Upload the 3 baseline CSV files to raw/ prefix."""
    if not bucket:
        errors.append("ETL_BUCKET not set, cannot seed")
        return

    # Exactly matching CDK stacks/s3/s3_etlcsv9q2.ts BucketDeployment
    seed_data = {
        "raw/orders_2026_01.csv": "order_id,customer_id,total\n1,42,99.95\n2,17,12.50\n3,99,7.25\n",
        "raw/orders_2026_02.csv": "order_id,customer_id,total\n4,42,42.00\n5,17,18.99\n",
        "raw/orders_2026_03.csv": "order_id,customer_id,total\n6,99,1.99\n7,42,250.00\n8,17,8.49\n",
    }

    logger.warning("\n[SEED] %s/raw/", bucket)
    for key, content in seed_data.items():
        try:
            s3.put_object(
                Bucket=bucket,
                Key=key,
                Body=content.encode("utf-8"),
            )
            logger.warning("  ✓ Uploaded: %s", key)
        except Exception as e:
            errors.append(f"seed {bucket}/{key}: {e}")
            logger.warning("  ✗ Failed: %s: %s", key, e)


def reset_data_plane(
    session: boto3.Session | None = None, region: str = REGION
) -> list[str]:
    """Reset the data plane to baseline state (clean + seed).

    Returns a list of error strings (empty on success). Never raises for a
    per-resource failure.
    """
    if session is None:
        session = boto3.Session(region_name=region)

    errors: list[str] = []

    etl_bucket = os.environ.get("ETL_BUCKET", "")

    s3 = session.client("s3", region_name=region)
    s3_resource = session.resource("s3", region_name=region)

    # === CLEAN ===
    logger.warning("=" * 60)
    logger.warning("Reset: s3-csv-to-xlsx-lambda-pipeline")
    logger.warning("Region: %s", region)
    logger.warning("=" * 60)

    logger.warning("\n>>> Phase 1: CLEAN")
    _wipe_bucket(s3, s3_resource, etl_bucket, errors)

    # === SEED ===
    logger.warning("\n>>> Phase 2: SEED (restore baseline data)")
    _seed_etl_bucket(s3, etl_bucket, errors)

    logger.warning("\n" + "=" * 60)
    if errors:
        logger.warning("Reset done with %d error(s).", len(errors))
    else:
        logger.warning("Reset done.")

    return errors
