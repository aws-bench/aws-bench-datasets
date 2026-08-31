"""Tier summary aggregator.

Consumes the fulfillment-event-records DynamoDB stream and maintains a
per-customer-tier rollup used by the fulfillment ops dashboard. It copies the
tier exactly as it was persisted by the processor - no enrichment happens here.
"""

import json
import logging
import os
import time

import boto3

SUMMARY_TABLE = os.environ["SUMMARY_TABLE"]

ddb = boto3.client("dynamodb")

LOG = logging.getLogger()
LOG.setLevel(logging.INFO)


def _string(image, key, default=""):
    value = image.get(key) or {}
    return value.get("S", default)


def handler(event, context):
    applied = 0
    for record in event.get("Records", []):
        if record.get("eventName") not in ("INSERT", "MODIFY"):
            continue
        image = (record.get("dynamodb") or {}).get("NewImage") or {}
        tier = _string(image, "customerTier", "UNKNOWN")
        event_type = _string(image, "eventType", "Unknown")

        ddb.update_item(
            TableName=SUMMARY_TABLE,
            Key={"tier": {"S": tier}},
            UpdateExpression=(
                "ADD recordCount :one, #typed :one SET lastUpdatedAt = :now"
            ),
            ExpressionAttributeNames={"#typed": "count_{}".format(event_type)},
            ExpressionAttributeValues={
                ":one": {"N": "1"},
                ":now": {"N": str(int(time.time()))},
            },
        )
        applied += 1

    LOG.info("AGGREGATED %s", json.dumps({"recordsApplied": applied}))
    return {"status": "ok", "applied": applied}
