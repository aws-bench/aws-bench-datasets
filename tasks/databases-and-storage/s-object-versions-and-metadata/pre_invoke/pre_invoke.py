"""Pre-invoke: find the most recently modified object and capture
its key and version ID. Also capture the version ID and size of prod_data.txt."""

import json
import os
import sys

import boto3

RESULT_FILE = "/logs/pre_invoke/placeholder.json"


def run(session=None, region="us-east-1", **parameters):
    if not session:
        session = boto3.Session(region_name=region)

    bucket_name = parameters["bucket_name"]
    s3 = session.client("s3", region_name=region)

    # Step 1: List all object versions in the bucket
    resp = s3.list_object_versions(Bucket=bucket_name)

    # Step 2: Filter to only the current (latest) version of each object
    current = [v for v in resp.get("Versions", []) if v["IsLatest"]]

    # Step 3: Find the most recently modified object across all keys
    most_recent = max(current, key=lambda v: v["LastModified"])

    # Step 4: Find the current version of the specific file "prod_data.txt"
    prod_data = next(v for v in current if v["Key"] == "prod_data.txt")

    return {
        "898c7f19-MostRecentKey": most_recent["Key"],
        "898c7f19-MostRecentVersionId": most_recent["VersionId"],
        "898c7f19-ProdDataVersionId": prod_data["VersionId"],
        "898c7f19-ProdDataSizeBytes": str(prod_data["Size"]),
    }


if __name__ == "__main__":
    try:
        placeholders = run(bucket_name=os.environ["BUCKET_NAME"])
    except Exception as e:
        print(f"pre_invoke failed: {e}", file=sys.stderr)
        sys.exit(1)

    # Write computed placeholder values to disk for the verifier to consume
    os.makedirs(os.path.dirname(RESULT_FILE), exist_ok=True)
    with open(RESULT_FILE, "w") as f:
        json.dump(placeholders, f, indent=2)
