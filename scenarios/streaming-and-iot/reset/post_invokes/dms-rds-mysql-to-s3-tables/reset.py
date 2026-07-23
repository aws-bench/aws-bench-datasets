"""Reset for dms-rds-mysql-to-s3-tables.

Deletes every table in the target S3 Tables bucket so a trial starts from
the empty baseline.

Usage:
    python reset.py
"""

import logging
import os
import time

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.WARNING)

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")


def _clean_s3_tables(
    session: boto3.Session, region: str, table_bucket_arn: str, errors: list[str]
):
    """Delete all tables in the S3 Tables bucket."""
    logger.warning("\n--- S3 Tables (baseline: none) ---")
    if not table_bucket_arn:
        logger.warning("[SKIP] No S3 Tables bucket ARN configured")
        return

    try:
        s3tables = session.client("s3tables", region_name=region)
        tables = []
        params = {"tableBucketARN": table_bucket_arn}
        while True:
            resp = s3tables.list_tables(**params)
            tables.extend(resp.get("tables", []))
            token = resp.get("continuationToken")
            if not token:
                break
            params["continuationToken"] = token

        if not tables:
            logger.warning("[OK] S3 Tables: already empty")
            return

        logger.warning("[DELETE] S3 Tables: %d tables", len(tables))
        for table in tables:
            try:
                s3tables.delete_table(
                    tableBucketARN=table_bucket_arn,
                    namespace=table["namespace"][0]
                    if isinstance(table.get("namespace"), list)
                    else table.get("namespace", "default"),
                    name=table["name"],
                )
                logger.warning("  Deleted: %s", table["name"])
            except Exception as e:
                errors.append(f"S3 Tables delete {table['name']} failed: {e}")
                logger.warning("  Failed %s: %s", table["name"], e)
    except Exception as e:
        errors.append(f"S3 Tables clean failed: {e}")
        logger.warning("[SKIP] S3 Tables: %s", e)


# ============================================================
# Clean: Wipe S3 bucket (DMS target)
# ============================================================


def _wipe_bucket(session: boto3.Session, bucket_arn: str, errors: list[str]):
    """Delete all objects and versions from an S3 bucket identified by ARN."""
    if not bucket_arn:
        logger.warning("[SKIP] No S3 bucket ARN configured")
        return
    bucket = bucket_arn.split("/")[-1]
    logger.warning("\n--- S3 bucket: %s ---", bucket)
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


# ============================================================
# DMS Clean
# ============================================================


def _stop_and_wait_for_task(
    dms, task_id: str, task_arn: str, status: str, errors: list[str]
):
    """Stop a running DMS task and wait for it to reach stopped state."""
    if status in ("running", "starting", "ready"):
        try:
            dms.stop_replication_task(ReplicationTaskArn=task_arn)
        except Exception as e:
            errors.append(f"DMS stop task {task_id} failed: {e}")
            logger.warning("  ✗ Stop failed: %s", e)

        for _ in range(30):
            time.sleep(2)
            try:
                cur = dms.describe_replication_tasks(
                    Filters=[{"Name": "replication-task-id", "Values": [task_id]}]
                ).get("ReplicationTasks", [])
                if not cur or cur[0].get("Status") in ("stopped", "failed"):
                    break
            except Exception:
                break


def _delete_dms_tasks(dms, errors: list[str]):
    """Delete all DMS replication tasks."""
    tasks = dms.describe_replication_tasks().get("ReplicationTasks", [])
    for task in tasks:
        task_id = task["ReplicationTaskIdentifier"]
        task_arn = task["ReplicationTaskArn"]
        status = task.get("Status", "")
        logger.warning("[DELETE] DMS task: %s (status: %s)", task_id, status)

        _stop_and_wait_for_task(dms, task_id, task_arn, status, errors)

        try:
            dms.delete_replication_task(ReplicationTaskArn=task_arn)
        except Exception as e:
            errors.append(f"DMS delete task {task_id} failed: {e}")
            logger.warning("  ✗ Delete failed: %s", e)

    if tasks:
        time.sleep(10)


def _delete_dms_endpoints(dms, errors: list[str]):
    """Delete all DMS endpoints."""
    for ep in dms.describe_endpoints().get("Endpoints", []):
        logger.warning("[DELETE] DMS endpoint: %s", ep["EndpointIdentifier"])
        try:
            dms.delete_endpoint(EndpointArn=ep["EndpointArn"])
        except Exception as e:
            errors.append(f"DMS delete endpoint {ep['EndpointIdentifier']} failed: {e}")
            logger.warning("  ✗ Failed: %s", e)


def _wait_for_no_instances(dms, errors: list[str], max_attempts=40, delay=15):
    """Poll until no replication instances remain (or timeout)."""
    for attempt in range(1, max_attempts + 1):
        try:
            instances = dms.describe_replication_instances().get(
                "ReplicationInstances", []
            )
            if not instances:
                logger.warning("  ✓ All replication instances deleted")
                return True
            statuses = [
                (
                    ri["ReplicationInstanceIdentifier"],
                    ri.get("ReplicationInstanceStatus", "?"),
                )
                for ri in instances
            ]
            logger.warning("  ... attempt %d/%d: %s", attempt, max_attempts, statuses)
        except Exception as e:
            logger.warning("  ... attempt %d: describe failed: %s", attempt, e)
        time.sleep(delay)
    errors.append("DMS timed out waiting for replication instances to delete")
    logger.warning("  ✗ Timed out waiting for instances to delete")
    return False


def _delete_dms_replication_instances(dms, errors: list[str]):
    """Delete all DMS replication instances and wait for them to be gone."""
    instances = dms.describe_replication_instances().get("ReplicationInstances", [])
    if not instances:
        logger.warning("[OK] No DMS replication instances")
        return

    for ri in instances:
        logger.warning("[DELETE] DMS instance: %s", ri["ReplicationInstanceIdentifier"])
        try:
            dms.delete_replication_instance(
                ReplicationInstanceArn=ri["ReplicationInstanceArn"]
            )
        except Exception as e:
            errors.append(
                f"DMS delete instance {ri['ReplicationInstanceIdentifier']} failed: {e}"
            )
            logger.warning("  ✗ Failed: %s", e)

    logger.warning("  Waiting for all replication instances to fully delete...")
    _wait_for_no_instances(dms, errors)


def _delete_dms_subnet_groups(dms, errors: list[str]):
    """Delete all DMS subnet groups (with retries in case instances are still deleting)."""
    subnet_groups = dms.describe_replication_subnet_groups().get(
        "ReplicationSubnetGroups", []
    )
    if not subnet_groups:
        logger.warning("[OK] No DMS subnet groups")
        return

    for sg in subnet_groups:
        sg_id = sg["ReplicationSubnetGroupIdentifier"]
        logger.warning("[DELETE] DMS subnet group: %s", sg_id)
        for attempt in range(1, 13):
            try:
                dms.delete_replication_subnet_group(
                    ReplicationSubnetGroupIdentifier=sg_id
                )
                logger.warning("  ✓ Deleted")
                break
            except ClientError as e:
                if "InvalidResourceStateFault" in str(e) and attempt < 12:
                    logger.warning(
                        "  ... instance still deleting, retry %d/12 in 15s", attempt
                    )
                    time.sleep(15)
                else:
                    errors.append(f"DMS delete subnet group {sg_id} failed: {e}")
                    logger.warning("  ✗ Failed: %s", e)
                    break


def _clean_dms(session: boto3.Session, region: str, errors: list[str]):
    """Delete all DMS resources (baseline has none)."""
    logger.warning("\n--- All DMS resources ---")
    dms = session.client("dms", region_name=region)
    _delete_dms_tasks(dms, errors)
    _delete_dms_endpoints(dms, errors)
    _delete_dms_replication_instances(dms, errors)
    _delete_dms_subnet_groups(dms, errors)


def reset_data_plane(
    session: boto3.Session | None = None, region: str = REGION
) -> list[str]:
    """Delete every table in the target S3 Tables bucket.

    Returns a list of error strings (empty on success); never raises for a
    per-resource failure.
    """
    if session is None:
        session = boto3.Session(region_name=region)

    errors: list[str] = []
    table_bucket_arn = os.environ.get("S3_TABLES_BUCKET_ARN", "")

    logger.warning("=" * 60)
    logger.warning("Reset: dms-rds-mysql-to-s3-tables")
    logger.warning("Region: %s", region)
    logger.warning("=" * 60)

    _clean_s3_tables(session, region, table_bucket_arn, errors)
    _wipe_bucket(session, table_bucket_arn, errors)
    _clean_dms(session, region, errors)

    if errors:
        logger.warning("Reset done with %d error(s).", len(errors))
    else:
        logger.warning("Reset done.")

    return errors
