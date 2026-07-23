"""Reset script for neptune-bulk-load-and-shortest-path task.

Clears the Neptune graph (all vertices + edges) via the bridge Lambda's
reset_data action, wipes the S3 loader bucket, then reseeds it with the
baseline vertices.csv + edges.csv files.

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

# Baseline seed data for the loader bucket
SEED_DATA = {
    "graph/vertices.csv": (
        "~id,~label,name:String\n"
        "v1,user,alice\n"
        "v2,user,bob\n"
        "v3,user,carol\n"
        "v4,user,diana\n"
        "v5,user,eve\n"
    ),
    "graph/edges.csv": (
        "~id,~from,~to,~label\n"
        "e1,v1,v2,knows\n"
        "e2,v1,v3,knows\n"
        "e3,v2,v4,knows\n"
        "e4,v3,v4,knows\n"
        "e5,v4,v5,knows\n"
        "e6,v2,v3,knows\n"
    ),
}


# ============================================================
# Clean: Neptune graph data
# ============================================================


def _reset_neptune_graph(
    session: boto3.Session, bridge_lambda_name: str, errors: list[str]
):
    """Invoke the bridge Lambda with action=reset_data to drop all vertices and edges."""
    logger.warning("\n--- Neptune graph (baseline: empty) ---")
    if not bridge_lambda_name:
        errors.append("BRIDGE_LAMBDA_NAME not set; cannot reset Neptune graph")
        logger.warning("[SKIP] BRIDGE_LAMBDA_NAME not set")
        return

    lambda_client = session.client("lambda", region_name=REGION)
    try:
        response = lambda_client.invoke(
            FunctionName=bridge_lambda_name,
            InvocationType="RequestResponse",
            Payload=json.dumps({"action": "reset_data"}).encode("utf-8"),
        )
        payload = json.loads(response["Payload"].read())
        if payload.get("ok"):
            logger.warning("  ✓ Neptune graph cleared (all vertices + edges dropped)")
        else:
            err_msg = payload.get("error", str(payload))
            errors.append(f"Neptune reset_data returned error: {err_msg}")
            logger.warning("  ✗ reset_data error: %s", err_msg)
    except ClientError as e:
        errors.append(f"Neptune reset_data invoke failed: {e}")
        logger.warning("  ✗ Invoke failed: %s", e)
    except Exception as e:
        errors.append(f"Neptune reset_data unexpected error: {e}")
        logger.warning("  ✗ Unexpected error: %s", e)


# ============================================================
# Clean: Wipe S3 loader bucket
# ============================================================


def _wipe_bucket(session: boto3.Session, bucket: str, errors: list[str]):
    """Delete all objects and versions from the loader bucket."""
    logger.warning("\n--- S3 loader bucket: %s ---", bucket)
    if not bucket:
        logger.warning("[SKIP] LOADER_BUCKET not set")
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


# ============================================================
# Seed: Re-upload vertices.csv + edges.csv
# ============================================================


def _seed_bucket(session: boto3.Session, bucket: str, errors: list[str]):
    """Upload baseline seed data (vertices.csv + edges.csv) to the loader bucket."""
    logger.warning("\n--- S3 seed data ---")
    if not bucket:
        logger.warning("[SKIP] LOADER_BUCKET not set, cannot seed")
        return
    s3 = session.client("s3", region_name=REGION)
    logger.warning("[SEED] %s", bucket)
    for key, content in SEED_DATA.items():
        try:
            s3.put_object(
                Bucket=bucket,
                Key=key,
                Body=content.encode("utf-8"),
            )
            logger.warning("  ✓ Uploaded: %s", key)
        except Exception as e:
            errors.append(f"S3 seed {bucket}/{key} failed: {e}")
            logger.warning("  ✗ Failed to upload %s: %s", key, e)


def reset_data_plane(
    session: boto3.Session | None = None, region: str = REGION
) -> list[str]:
    """Reset the data plane to baseline state.

    1. Clear the Neptune graph via the bridge Lambda.
    2. Wipe the S3 loader bucket.
    3. Reseed the bucket with vertices.csv + edges.csv.

    Returns a list of error strings (empty on success). Never raises for a
    per-resource failure.
    """
    if session is None:
        session = boto3.Session(region_name=region)

    errors: list[str] = []

    bridge_lambda_name = os.environ.get("BRIDGE_LAMBDA_NAME", "")
    loader_bucket = os.environ.get("LOADER_BUCKET", "")

    # === CLEAN ===
    logger.warning("=" * 60)
    logger.warning("Reset: neptune-bulk-load-and-shortest-path")
    logger.warning("Region: %s", region)
    logger.warning("=" * 60)

    _reset_neptune_graph(session, bridge_lambda_name, errors)
    _wipe_bucket(session, loader_bucket, errors)

    # === SEED ===
    logger.warning("\n>>> Phase 2: SEED (restore baseline data)")
    _seed_bucket(session, loader_bucket, errors)

    logger.warning("\n" + "=" * 60)
    if errors:
        logger.warning("Reset done with %d error(s).", len(errors))
    else:
        logger.warning("Reset done.")

    return errors
