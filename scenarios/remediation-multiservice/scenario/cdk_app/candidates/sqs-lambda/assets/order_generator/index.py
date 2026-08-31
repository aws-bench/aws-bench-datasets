"""Storefront ingest gateway.

Invoked once per minute by an EventBridge rule. Publishes the order events that
arrive from the storefront checkout flow, plus the notification and payment
settlement events that ride the same ingest tier.
"""

import json
import os
import time

import boto3

sqs = boto3.client("sqs")

ORDERS_QUEUE_URL = os.environ["ORDERS_QUEUE_URL"]
NOTIFICATIONS_QUEUE_URL = os.environ["NOTIFICATIONS_QUEUE_URL"]
PAYMENTS_QUEUE_URL = os.environ["PAYMENTS_QUEUE_URL"]

ORDERS_PER_RUN = int(os.environ.get("ORDERS_PER_RUN", "20"))
NOTIFICATIONS_PER_RUN = int(os.environ.get("NOTIFICATIONS_PER_RUN", "8"))
PAYMENTS_PER_RUN = int(os.environ.get("PAYMENTS_PER_RUN", "3"))
LINE_ITEMS_PER_ORDER = int(os.environ.get("LINE_ITEMS_PER_ORDER", "10"))

# SKUs seeded into the inventory catalog table.
SKUS = [f"SKU-{1000 + i}" for i in range(40)]
CHANNELS = ["web", "ios", "android", "partner-api"]
WAREHOUSES = ["ORD1", "DFW2", "EWR3"]


def _order(seq: int, batch_id: int) -> dict:
    line_items = []
    for i in range(LINE_ITEMS_PER_ORDER):
        sku = SKUS[(seq * LINE_ITEMS_PER_ORDER + i) % len(SKUS)]
        line_items.append(
            {
                "sku": sku,
                "qty": 1 + ((seq + i) % 4),
                "unit_price_cents": 1200 + ((seq + i) % 37) * 50,
            }
        )
    return {
        "order_id": f"ORD-{batch_id}-{seq:04d}",
        "customer_id": f"CUST-{(batch_id + seq) % 5000:05d}",
        "channel": CHANNELS[seq % len(CHANNELS)],
        "warehouse": WAREHOUSES[seq % len(WAREHOUSES)],
        "submitted_at": batch_id,
        "line_items": line_items,
    }


def _send(queue_url: str, bodies: list) -> int:
    sent = 0
    for i in range(0, len(bodies), 10):
        chunk = bodies[i : i + 10]
        entries = [
            {"Id": str(n), "MessageBody": json.dumps(body)}
            for n, body in enumerate(chunk)
        ]
        resp = sqs.send_message_batch(QueueUrl=queue_url, Entries=entries)
        sent += len(resp.get("Successful", []))
        for failed in resp.get("Failed", []):
            print(json.dumps({"msg": "send_failed", "detail": failed}))
    return sent


def handler(event, context):
    batch_id = int(time.time())

    orders = [_order(seq, batch_id) for seq in range(ORDERS_PER_RUN)]
    notifications = [
        {
            "notification_id": f"NTF-{batch_id}-{seq:03d}",
            "template": "order_received",
            "customer_id": f"CUST-{(batch_id + seq) % 5000:05d}",
            "channel": CHANNELS[seq % len(CHANNELS)],
            "emitted_at": batch_id,
        }
        for seq in range(NOTIFICATIONS_PER_RUN)
    ]
    payments = [
        {
            "payment_id": f"PAY-{batch_id}-{seq:03d}",
            "order_id": f"ORD-{batch_id}-{seq:04d}",
            "amount_cents": 4500 + seq * 125,
            "processor": "stripe" if seq % 2 == 0 else "adyen",
            "emitted_at": batch_id,
        }
        for seq in range(PAYMENTS_PER_RUN)
    ]

    counts = {
        "orders": _send(ORDERS_QUEUE_URL, orders),
        "notifications": _send(NOTIFICATIONS_QUEUE_URL, notifications),
        "payments": _send(PAYMENTS_QUEUE_URL, payments),
    }
    print(json.dumps({"msg": "ingest_batch_published", "batch_id": batch_id, **counts}))
    return counts
