#!/bin/bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
BUCKET="${BUCKET_NAME}"
OUT=/logs/agent/agent-output.txt

BUCKET="$BUCKET" REGION="$REGION" python3 - <<'PY'
import csv, io, json, os, re
from collections import Counter
import boto3

bucket = os.environ["BUCKET"]
region = os.environ["REGION"]
s3 = boto3.client("s3", region_name=region)
csv_re = re.compile(r"^part-.*\.csv$")

total = active = 0
merchants = Counter()
customers = Counter()
for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket):
    for obj in page.get("Contents", []) or []:
        key = obj["Key"]
        if not csv_re.match(key):
            continue
        body = s3.get_object(Bucket=bucket, Key=key)["Body"].read().decode("utf-8")
        for row in csv.DictReader(io.StringIO(body)):
            total += 1
            if row.get("status") == "ACTIVE":
                active += 1
            m = (row.get("merchant_id") or "").strip()
            if m:
                merchants[m] += 1
            c = (row.get("customerbaid") or "").strip()
            if c:
                customers[c] += 1

top_merchants = [{"id": k, "count": v} for k, v in merchants.most_common(5)]
top_customers = [{"id": k, "count": v} for k, v in customers.most_common(5)]
summary = {
    "total_deals": total,
    "active_deals": active,
    "archived_deals": total - active,
    "top_merchants": top_merchants,
    "top_customers": top_customers,
}
s3.put_object(
    Bucket=bucket,
    Key="reports/summary.json",
    Body=json.dumps(summary).encode("utf-8"),
    ContentType="application/json",
    Tagging="Environment=production&ReportType=analysis",
)
s3.put_bucket_lifecycle_configuration(
    Bucket=bucket,
    LifecycleConfiguration={
        "Rules": [
            {
                "ID": "reports-glacier-90d",
                "Status": "Enabled",
                "Filter": {"Prefix": "reports/"},
                "Transitions": [{"Days": 90, "StorageClass": "GLACIER"}],
            }
        ]
    },
)
PY

mkdir -p "$(dirname "$OUT")" && echo "Done." > "$OUT"
