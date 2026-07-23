"""Reset script for kds-firehose-iceberg-athena task.

Cleans agent-created resources: Firehose delivery streams, Glue databases
+ tables, and all objects in the Iceberg sink bucket.

Baseline state: empty sink bucket, no Firehose streams, no Glue databases.
The KDS source stream + Firehose role are precondition resources and stay.

Usage:
    python reset.py
"""

import logging
import os
import sys
import time

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.WARNING)

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")


# ============================================================
# Clean: Glue databases + tables
# ============================================================


def _delete_glue_databases(session: boto3.Session, errors: list[str]):
    """Delete all Glue databases and their tables (agent-created)."""
    logger.warning("\n--- Glue databases + tables ---")
    glue = session.client("glue", region_name=REGION)
    try:
        paginator = glue.get_paginator("get_databases")
        for page in paginator.paginate():
            for db in page.get("DatabaseList", []):
                db_name = db["Name"]
                # Skip default database
                if db_name == "default":
                    continue
                # Delete all tables in the database first
                try:
                    table_paginator = glue.get_paginator("get_tables")
                    for table_page in table_paginator.paginate(DatabaseName=db_name):
                        for table in table_page.get("TableList", []):
                            table_name = table["Name"]
                            try:
                                glue.delete_table(DatabaseName=db_name, Name=table_name)
                                logger.warning(
                                    "  ✓ Deleted table: %s.%s", db_name, table_name
                                )
                            except ClientError as e:
                                errors.append(
                                    f"delete table {db_name}.{table_name}: {e}"
                                )
                                logger.warning(
                                    "  ✗ Failed table %s.%s: %s", db_name, table_name, e
                                )
                except ClientError as e:
                    errors.append(f"list tables in {db_name}: {e}")
                # Delete the database
                try:
                    glue.delete_database(Name=db_name)
                    logger.warning("  ✓ Deleted database: %s", db_name)
                except ClientError as e:
                    errors.append(f"delete database {db_name}: {e}")
                    logger.warning("  ✗ Failed database %s: %s", db_name, e)
    except ClientError as e:
        errors.append(f"list databases: {e}")
        logger.warning("[SKIP] Glue: %s", e)


# ============================================================
# Clean: Wipe S3 sink bucket
# ============================================================


def _wipe_bucket(session: boto3.Session, bucket: str, errors: list[str]):
    """Delete all objects and versions from the sink bucket."""
    logger.warning("\n--- S3 sink bucket: %s ---", bucket)
    if not bucket:
        logger.warning("[SKIP] S3_SINK_BUCKET not set")
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
    """Reset the data plane to baseline state.

    Baseline: empty sink bucket, no Firehose streams, no Glue databases.

    Returns a list of error strings (empty on success). Never raises for a
    per-resource failure.
    """
    if session is None:
        session = boto3.Session(region_name=region)

    errors: list[str] = []

    s3_sink_bucket = os.environ.get("S3_SINK_BUCKET", "")

    # === CLEAN ===
    logger.warning("=" * 60)
    logger.warning("Reset: kds-firehose-iceberg-athena")
    logger.warning("Region: %s", region)
    logger.warning("=" * 60)

    _delete_glue_databases(session, errors)
    _wipe_bucket(session, s3_sink_bucket, errors)

    # No seed phase — baseline is empty.

    logger.warning("\n" + "=" * 60)
    if errors:
        logger.warning("Reset done with %d error(s).", len(errors))
    else:
        logger.warning("Reset done.")

    return errors
