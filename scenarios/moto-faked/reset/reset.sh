#!/bin/bash
# Reset hook for moto-faked scenario.
# Re-seeds the data plane to the per-task baseline: empty `incoming/`
# prefix, empty order-events queue, no ord-1001 item. Every step is
# delete-only toward the baseline, so reset is idempotent, safe to retry,
# and safe after partial failure. Honors AWS_ENDPOINT_URL (moto or real AWS).
set -euo pipefail

: "${LANDING_BUCKET:?LANDING_BUCKET is not set}"
: "${ORDER_QUEUE_URL:?ORDER_QUEUE_URL is not set}"
: "${ORDERS_TABLE:?ORDERS_TABLE is not set}"

export LANDING_BUCKET ORDER_QUEUE_URL ORDERS_TABLE

python3 - <<'EOF'
import os
import time

import boto3
from botocore.exceptions import ClientError

region = os.environ.get("AWS_REGION", "us-east-1")
endpoint = os.environ.get("AWS_ENDPOINT_URL") or None
session = boto3.Session()

errors = []

s3 = session.client("s3", region_name=region, endpoint_url=endpoint)
try:
    pages = s3.get_paginator("list_objects_v2").paginate(
        Bucket=os.environ["LANDING_BUCKET"], Prefix="incoming/"
    )
    for page in pages:
        for obj in page.get("Contents", []):
            s3.delete_object(Bucket=os.environ["LANDING_BUCKET"], Key=obj["Key"])
except ClientError as e:
    errors.append(f"s3 reset: {e}")

sqs = session.client("sqs", region_name=region, endpoint_url=endpoint)
try:
    sqs.purge_queue(QueueUrl=os.environ["ORDER_QUEUE_URL"])
    time.sleep(1)
except ClientError as e:
    errors.append(f"sqs reset: {e}")

table = session.resource("dynamodb", region_name=region, endpoint_url=endpoint).Table(
    os.environ["ORDERS_TABLE"]
)
try:
    table.delete_item(Key={"orderId": "ord-1001"})
except ClientError as e:
    errors.append(f"ddb reset: {e}")

for err in errors:
    print(err)
print("[reset.sh] moto-faked data plane reset to baseline.")
EOF
