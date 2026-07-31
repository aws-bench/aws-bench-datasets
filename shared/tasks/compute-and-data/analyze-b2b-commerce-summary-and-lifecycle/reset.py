"""Data-plane reset for analyze-b2b-commerce-summary-and-lifecycle.

Empties the source bucket, drops any reports/ lifecycle rule, and re-puts the
five CSV parts (part-00000.csv .. part-00004.csv). Called from both pre_invoke
and post_invoke; best-effort, returns error strings.
"""

import mimetypes
import os

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
BUCKET_NAME = os.environ.get("B2B_DATA_BUCKET", "")


def _csv_part(part: int) -> str:
    """Build CSV part `part`: a header plus 1200 rows."""
    headers = (
        "merchant_id,customerbaid,dealId,dealname,asin,"
        "originalsku,dealppu,startDate,endDate,status"
    )
    deal_ids = [
        "DEAL_001",
        "DEAL_002",
        "DEAL_003",
        "DEAL_004",
        "DEAL_005",
        "DEAL_006",
        "DEAL_007",
        "DEAL_008",
        "DEAL_009",
        "DEAL_010",
    ]
    rows: list[str] = []
    for i in range(part * 1200, (part + 1) * 1200):
        deal_id = deal_ids[i % 10]
        status = "ARCHIVED" if i % 7 == 0 else "ACTIVE"
        end_date = "" if i % 11 == 0 else "2024-12-31"
        deal_name = f'"Deal Name {i}, Special Offer, Limited Time"'
        start_date = "2024-01-01"
        if deal_id == "DEAL_001" or deal_id == "DEAL_002":
            start_date = ["2024-01-01", "2024-03-15", "2024-06-01"][i % 3]
        n = i % 10000
        rows.append(
            ",".join(
                [
                    f"MERCHANT_{i % 100}",
                    f"CUSTOMER_{i % 50}",
                    deal_id,
                    deal_name,
                    f"B{n:010d}",
                    f'"SKU-{i % 1000}, Premium"',
                    f"{n // 100}.{n % 100:02d}",
                    start_date,
                    end_date,
                    status,
                ]
            )
        )
    return "\n".join([headers] + rows)


OBJECTS: dict[str, str] = {f"part-{i:05d}.csv": _csv_part(i) for i in range(5)}


def _empty(s3, bucket: str, errors: list[str]) -> None:
    """Delete all object versions and delete markers."""
    try:
        paginator = s3.get_paginator("list_object_versions")
        for page in paginator.paginate(Bucket=bucket):
            to_delete = [
                {"Key": v["Key"], "VersionId": v["VersionId"]}
                for v in (page.get("Versions", []) + page.get("DeleteMarkers", []))
            ]
            if to_delete:
                s3.delete_objects(Bucket=bucket, Delete={"Objects": to_delete})
    except ClientError as e:
        errors.append(f"empty {bucket}: {e}")


def _put(s3, bucket: str, key: str, body: str, errors: list[str]) -> None:
    ctype = mimetypes.guess_type(key)[0] or "application/octet-stream"
    try:
        s3.put_object(
            Bucket=bucket, Key=key, Body=body.encode("utf-8"), ContentType=ctype
        )
    except ClientError as e:
        errors.append(f"put {key}: {e}")


LIFECYCLE_PREFIX = "reports/"


def _filter_prefix(rule: dict):
    # legacy top-level Prefix, or Filter.Prefix / Filter.And.Prefix
    flt = rule.get("Filter") or {}
    return (
        rule.get("Prefix") or flt.get("Prefix") or (flt.get("And") or {}).get("Prefix")
    )


def _clear_lifecycle(s3, bucket: str, errors: list[str]) -> None:
    """Drop any lifecycle rule scoped to reports/, removing the whole config if
    it was the only rule."""
    try:
        config = s3.get_bucket_lifecycle_configuration(Bucket=bucket)
        rules = config.get("Rules") or []
        kept = [r for r in rules if _filter_prefix(r) != LIFECYCLE_PREFIX]
        if not kept:
            s3.delete_bucket_lifecycle(Bucket=bucket)
        elif len(kept) != len(rules):
            s3.put_bucket_lifecycle_configuration(
                Bucket=bucket, LifecycleConfiguration={"Rules": kept}
            )
    except ClientError as e:
        if "NoSuchLifecycleConfiguration" not in str(e):
            errors.append(f"clear lifecycle: {e}")


def reset_data_plane(
    session: "boto3.Session | None" = None, region: str = REGION
) -> list[str]:
    """Empty the bucket, drop the reports/ lifecycle rule, and re-put the seed.

    Idempotent; returns error strings (empty on success), never raises per-object.
    """
    if not BUCKET_NAME:
        return []
    if session is None:
        session = boto3.Session(region_name=region)
    s3 = session.client("s3", region_name=region)
    errors: list[str] = []
    _empty(s3, BUCKET_NAME, errors)
    _clear_lifecycle(s3, BUCKET_NAME, errors)
    for key, body in OBJECTS.items():
        _put(s3, BUCKET_NAME, key, body, errors)
    return errors
