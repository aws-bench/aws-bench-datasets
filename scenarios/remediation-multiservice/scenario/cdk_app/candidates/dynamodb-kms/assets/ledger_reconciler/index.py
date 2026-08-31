"""Nightly reconciler -- rolls up merchant aggregates and publishes a report to S3.

Reads the analytics table (encrypted with the analytics CMK) and writes an
SSE-KMS encrypted report object.
"""

import json
import logging
import os
import time

import boto3

LOG = logging.getLogger()
LOG.setLevel(logging.INFO)

TABLE_NAME = os.environ["ANALYTICS_TABLE_NAME"]
BUCKET_NAME = os.environ["REPORT_BUCKET_NAME"]
KEY_ARN = os.environ["ANALYTICS_KMS_KEY_ARN"]

_ddb = boto3.client("dynamodb")
_s3 = boto3.client("s3")


def handler(event, context):
    totals = {}
    scanned = 0
    paginator = _ddb.get_paginator("scan")
    for page in paginator.paginate(TableName=TABLE_NAME):
        for item in page.get("Items", []):
            scanned += 1
            merchant = item["merchantId"]["S"]
            totals[merchant] = totals.get(merchant, 0) + int(
                item.get("grossMinor", {"N": "0"})["N"]
            )

    report = {
        "generatedAt": int(time.time()),
        "scannedRows": scanned,
        "merchantTotalsMinor": totals,
    }
    key = "reports/merchant-rollup-latest.json"
    _s3.put_object(
        Bucket=BUCKET_NAME,
        Key=key,
        Body=json.dumps(report, sort_keys=True).encode("utf-8"),
        ContentType="application/json",
        ServerSideEncryption="aws:kms",
        SSEKMSKeyId=KEY_ARN,
    )
    LOG.info(
        "reconcile.report_written bucket=%s key=%s rows=%d", BUCKET_NAME, key, scanned
    )
    return {"statusCode": 200, "scannedRows": scanned, "reportKey": key}
