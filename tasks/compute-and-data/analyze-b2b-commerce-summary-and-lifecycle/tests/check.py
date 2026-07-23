"""Programmatic verifier

Inputs (env vars from [verifier.env]):
    compute-and-data-s3-dkj487ewd-us-east-1-BucketName

The bucket comes pre-populated with `part-NNNNN.csv` files. The agent must:
  1. produce reports/summary.json with the correct aggregate counts and
     top-5 merchants/customers structures
  2. tag that object Environment=production, ReportType=analysis
  3. add a bucket lifecycle rule transitioning reports/ to GLACIER at 90d.

Each @criterion catches its own ClientError and returns False — bare
exceptions abort the entire reward in rewardkit (TaskGroup semantics), so
defensive catches are required, not optional.
"""

import csv
import io
import json
import os
import re
from collections import Counter
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

# ── Inputs ───────────────────────────────────────────────────────────────────

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")

# The bucket is published as a CFN export and given to the agent in the
# instruction prompt — the agent has no choice. All criteria operate
# against this expected bucket directly; if the agent ignored the prompt
# and operated on a different bucket, every downstream criterion fails.
# No agent-output.json contract is needed for this task.
BUCKET_NAME = os.environ["EXPECTED_BUCKET"]

SUMMARY_KEY = "reports/summary.json"
REQUIRED_OBJECT_TAGS = {"Environment": "production", "ReportType": "analysis"}
GLACIER_TRANSITION_DAYS = 90
LIFECYCLE_PREFIX = "reports/"
SOURCE_CSV_RE = re.compile(r"^part-.*\.csv$")
REQUIRED_SUMMARY_FIELDS = (
    "total_deals",
    "active_deals",
    "archived_deals",
    "top_merchants",
    "top_customers",
)


def _s3():
    return boto3.client("s3", region_name=REGION)


def _expected_counts() -> tuple[int, int, int]:
    """Recompute total/active/archived from the source CSVs in the bucket.

    Mirrors validate.py: iterate every `part-*.csv`, sum total rows,
    increment `active` on `status == "ACTIVE"`. archived = total - active.
    """
    s3 = _s3()
    total = 0
    active = 0
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET_NAME):
        for obj in page.get("Contents", []) or []:
            key = obj["Key"]
            if not SOURCE_CSV_RE.match(key):
                continue
            body = (
                s3.get_object(Bucket=BUCKET_NAME, Key=key)["Body"]
                .read()
                .decode("utf-8")
            )
            for row in csv.DictReader(io.StringIO(body)):
                total += 1
                if row.get("status") == "ACTIVE":
                    active += 1
    return total, active, total - active


def _compute_top_counts(column: str) -> set[int]:
    """Compute the set of valid top-5 counts for a given column.

    Since all entities may be tied, returns the set of counts that any
    valid top-5 entry could have (i.e. the top 5 count values).
    """
    s3 = _s3()
    counter: Counter = Counter()
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET_NAME):
        for obj in page.get("Contents", []) or []:
            key = obj["Key"]
            if not SOURCE_CSV_RE.match(key):
                continue
            body = (
                s3.get_object(Bucket=BUCKET_NAME, Key=key)["Body"]
                .read()
                .decode("utf-8")
            )
            for row in csv.DictReader(io.StringIO(body)):
                val = row.get(column, "").strip()
                if val:
                    counter[val] += 1
    top_5_counts = sorted(counter.values(), reverse=True)[:5]
    return set(top_5_counts)


def _load_summary() -> dict | None:
    """Fetch and parse reports/summary.json. Return None on any failure."""
    s3 = _s3()
    try:
        body = s3.get_object(Bucket=BUCKET_NAME, Key=SUMMARY_KEY)["Body"].read()
    except ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey"):
            return None
        raise
    try:
        return json.loads(body.decode("utf-8"))
    except json.JSONDecodeError:
        return None


# ── Criteria ─────────────────────────────────────────────────────────────────


@criterion(description="reports/summary.json exists in the expected bucket")
def summary_uploaded(workspace: Path) -> bool:
    s3 = _s3()
    try:
        s3.head_object(Bucket=BUCKET_NAME, Key=SUMMARY_KEY)
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey"):
            return False
        raise


@criterion(
    description="summary.json has total_deals/active_deals/archived_deals/top_merchants/top_customers"
)
def summary_has_required_fields(workspace: Path) -> bool:
    data = _load_summary()
    if data is None:
        return False
    return all(field in data for field in REQUIRED_SUMMARY_FIELDS)


@criterion(
    description="total_deals / active_deals / archived_deals match the source CSV aggregates"
)
def summary_counts_match_source(workspace: Path) -> bool:
    data = _load_summary()
    if data is None:
        return False
    expected_total, expected_active, expected_archived = _expected_counts()
    return (
        data.get("total_deals") == expected_total
        and data.get("active_deals") == expected_active
        and data.get("archived_deals") == expected_archived
    )


@criterion(
    description="top_merchants is a list of 5 dicts each containing a 'count' key"
)
def top_merchants_well_formed(workspace: Path) -> bool:
    data = _load_summary()
    if data is None:
        return False
    items = data.get("top_merchants")
    return (
        isinstance(items, list)
        and len(items) == 5
        and all(isinstance(it, dict) and "count" in it for it in items)
    )


@criterion(description="top_merchants counts are correct based on source CSV data")
def top_merchants_counts_correct(workspace: Path) -> bool:
    data = _load_summary()
    if data is None:
        return False
    items = data.get("top_merchants")
    if not isinstance(items, list) or len(items) != 5:
        return False
    expected_counts = _compute_top_counts("merchant_id")
    for it in items:
        if not isinstance(it, dict) or "count" not in it:
            return False
        if it["count"] not in expected_counts:
            return False
    return True


@criterion(
    description="top_customers is a list of 5 dicts each containing a 'count' key"
)
def top_customers_well_formed(workspace: Path) -> bool:
    data = _load_summary()
    if data is None:
        return False
    items = data.get("top_customers")
    return (
        isinstance(items, list)
        and len(items) == 5
        and all(isinstance(it, dict) and "count" in it for it in items)
    )


@criterion(description="top_customers counts are correct based on source CSV data")
def top_customers_counts_correct(workspace: Path) -> bool:
    data = _load_summary()
    if data is None:
        return False
    items = data.get("top_customers")
    if not isinstance(items, list) or len(items) != 5:
        return False
    expected_counts = _compute_top_counts("customerbaid")
    for it in items:
        if not isinstance(it, dict) or "count" not in it:
            return False
        if it["count"] not in expected_counts:
            return False
    return True


@criterion(
    description="summary.json has tags Environment=production and ReportType=analysis"
)
def summary_object_tagged(workspace: Path) -> bool:
    s3 = _s3()
    try:
        resp = s3.get_object_tagging(Bucket=BUCKET_NAME, Key=SUMMARY_KEY)
    except ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey"):
            return False
        raise
    tags = {t["Key"]: t["Value"] for t in resp.get("TagSet", []) or []}
    return all(tags.get(k) == v for k, v in REQUIRED_OBJECT_TAGS.items())


@criterion(
    description=f"bucket has enabled lifecycle rule for prefix {LIFECYCLE_PREFIX!r} with {GLACIER_TRANSITION_DAYS}-day GLACIER transition"
)
def lifecycle_rule_present(workspace: Path) -> bool:
    s3 = _s3()
    try:
        config = s3.get_bucket_lifecycle_configuration(Bucket=BUCKET_NAME)
    except ClientError as e:
        if e.response["Error"]["Code"] == "NoSuchLifecycleConfiguration":
            return False
        raise
    for rule in config.get("Rules", []) or []:
        if rule.get("Status") != "Enabled":
            continue
        # Accept three prefix shapes: legacy v1 top-level `Prefix`, modern
        # `Filter.Prefix`, and `Filter.And.Prefix`. boto3's
        # put_bucket_lifecycle_configuration accepts either, and S3
        # returns whichever shape was submitted.
        flt = rule.get("Filter") or {}
        prefix = (
            rule.get("Prefix")
            or flt.get("Prefix")
            or (flt.get("And") or {}).get("Prefix")
        )
        if prefix != LIFECYCLE_PREFIX:
            continue
        for t in rule.get("Transitions", []) or []:
            if (
                t.get("Days") == GLACIER_TRANSITION_DAYS
                and t.get("StorageClass") == "GLACIER"
            ):
                return True
    return False
