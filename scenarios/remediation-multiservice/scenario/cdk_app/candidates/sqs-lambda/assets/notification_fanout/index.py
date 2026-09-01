"""Notification fan-out consumer (healthy reference pipeline)."""

import json
import os
import time

import boto3

ddb = boto3.resource("dynamodb")
_table = ddb.Table(os.environ["NOTIFICATIONS_TABLE"])


def handler(event, context):
    records = event.get("Records", [])
    written = 0
    with _table.batch_writer() as batch:
        for record in records:
            try:
                body = json.loads(record["body"])
            except Exception:
                continue
            now_ms = int(time.time() * 1000)
            batch.put_item(
                Item={
                    "notification_id": body.get("notification_id", record["messageId"]),
                    "delivered_at_ms": now_ms,
                    "template": body.get("template", "unknown"),
                    "customer_id": body.get("customer_id", "UNKNOWN"),
                    "channel": body.get("channel", "unknown"),
                    "status": "DELIVERED",
                }
            )
            written += 1
    print(json.dumps({"msg": "notifications_delivered", "count": written}))
    return {"batchItemFailures": []}
