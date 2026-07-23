"""Pre-invoke: count S3 buckets created more than one day ago."""

import json
import os
import sys
from datetime import datetime, timedelta, timezone

import boto3

RESULT_FILE = "/logs/pre_invoke/placeholder.json"


def run(session=None, region="us-east-1", **parameters):
    if not session:
        session = boto3.Session(region_name=region)

    s3 = session.client("s3")

    # Step 1: List all S3 buckets in the account
    buckets = s3.list_buckets().get("Buckets", [])

    # Step 2: Count how many were created more than 24 hours ago
    cutoff = datetime.now(timezone.utc) - timedelta(days=1)
    count = sum(1 for b in buckets if b["CreationDate"] < cutoff)

    return {"c480b808-BucketCount": str(count)}


if __name__ == "__main__":
    try:
        placeholders = run()
    except Exception as e:
        print(f"pre_invoke failed: {e}", file=sys.stderr)
        sys.exit(1)

    # Write computed placeholder values to disk for the verifier to consume
    os.makedirs(os.path.dirname(RESULT_FILE), exist_ok=True)
    with open(RESULT_FILE, "w") as f:
        json.dump(placeholders, f, indent=2)
