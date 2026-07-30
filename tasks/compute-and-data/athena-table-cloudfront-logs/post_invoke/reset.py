"""Shared data-plane reset for athena-table-cloudfront-logs.

Two responsibilities, both scoped to the CloudFront log bucket:

1. Scans all Glue databases and tables in the region and deletes any table
   (and its parent database, if left empty) whose StorageDescriptor.Location
   references the CloudFront log bucket.
2. Purges Athena query-result objects the agent's queries wrote into the log
   bucket under the ``athena-results/`` prefix. These are not tracked by the
   framework's resource-level snapshot/scan (it inventories buckets, not
   individual objects), so a query-output object left behind in a *baseline*
   bucket survives the framework reset and surfaces as a leak. Only the
   query-output prefix is purged; baseline log data elsewhere in the bucket is
   left untouched.

This ensures each trial starts from a clean slate with no pre-existing
Athena/Glue resources pointing at the log bucket and no stale query results.

Imported and called by both pre_invoke and post_invoke. Config is read from environment variables.
Best-effort: returns a list of error strings rather than raising.
"""

import os

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
LOG_BUCKET = os.environ.get("EXPECTED_LOG_BUCKET", "")
# Prefix under LOG_BUCKET where Athena writes query results. The output
# location is agent-chosen at query time; ``athena-results/`` is the
# observed/conventional value. Override via env if a scenario ever configures a
# different Athena output location.
ATHENA_RESULTS_PREFIX = os.environ.get("ATHENA_RESULTS_PREFIX", "athena-results/")


def _purge_query_results(s3, bucket: str, prefix: str, errors: list[str]) -> None:
    """Delete every object (all versions) under ``prefix`` in ``bucket``.

    Athena writes one result object per query execution (``<id>.csv`` +
    ``<id>.csv.metadata`` for SELECTs, an empty ``<id>.txt`` for DDL/utility
    statements). ``list_object_versions`` returns current objects with a
    VersionId of ``'null'`` on a non-versioned bucket, so this single path
    covers both versioned and non-versioned buckets; the paginator caps each
    page at 1000, matching the ``delete_objects`` limit.
    """
    if not prefix:
        return
    try:
        paginator = s3.get_paginator("list_object_versions")
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            to_delete = [
                {"Key": v["Key"], "VersionId": v["VersionId"]}
                for v in page.get("Versions", []) + page.get("DeleteMarkers", [])
            ]
            if to_delete:
                s3.delete_objects(Bucket=bucket, Delete={"Objects": to_delete})
    except ClientError as e:
        errors.append(f"purge s3://{bucket}/{prefix}: {e}")


def reset_data_plane(
    session: boto3.Session | None = None, region: str = REGION
) -> list[str]:
    """Delete task Glue databases and purge Athena query results.

    If any table in a database has a StorageDescriptor.Location referencing
    the log bucket, the entire database and all its tables are deleted
    (the assumption is the database was created as part of the task). Then
    any Athena query-result objects under ``ATHENA_RESULTS_PREFIX`` in the log
    bucket are purged.

    Returns a list of error strings (empty on success). Never raises for
    per-resource failures.
    """
    if not LOG_BUCKET:
        return ["EXPECTED_LOG_BUCKET not set; skipping reset"]

    if session is None:
        session = boto3.Session(region_name=region)
    glue = session.client("glue", region_name=region)
    errors: list[str] = []

    # Discover all databases
    databases: list[str] = []
    try:
        paginator = glue.get_paginator("get_databases")
        for page in paginator.paginate():
            for db in page.get("DatabaseList", []):
                databases.append(db["Name"])
    except ClientError as e:
        errors.append(f"get_databases: {e}")
        # Fall through: still attempt the query-result purge below.
        databases = []

    for db_name in databases:
        db_references_bucket = False

        try:
            table_paginator = glue.get_paginator("get_tables")
            for page in table_paginator.paginate(DatabaseName=db_name):
                for table in page.get("TableList", []):
                    location = table.get("StorageDescriptor", {}).get("Location", "")
                    if LOG_BUCKET in location:
                        db_references_bucket = True
                        break
                if db_references_bucket:
                    break
        except ClientError as e:
            errors.append(f"get_tables({db_name}): {e}")
            continue

        # If any table in the database references the log bucket, drop the
        # entire database — it was created as part of the task.
        if db_references_bucket:
            # Delete all tables first (required before deleting the database)
            try:
                table_paginator = glue.get_paginator("get_tables")
                for page in table_paginator.paginate(DatabaseName=db_name):
                    for table in page.get("TableList", []):
                        try:
                            glue.delete_table(DatabaseName=db_name, Name=table["Name"])
                        except ClientError as e:
                            errors.append(
                                f"delete_table {db_name}.{table['Name']}: {e}"
                            )
            except ClientError as e:
                errors.append(f"get_tables({db_name}) during cleanup: {e}")
                continue

            try:
                glue.delete_database(Name=db_name)
            except ClientError as e:
                errors.append(f"delete_database {db_name}: {e}")

    # Purge Athena query-result objects the agent wrote into the log bucket.
    # They live in a baseline bucket, so the framework's resource-level reset
    # never sees them (it inventories buckets, not objects) — clean them here.
    s3 = session.client("s3", region_name=region)
    _purge_query_results(s3, LOG_BUCKET, ATHENA_RESULTS_PREFIX, errors)

    return errors
