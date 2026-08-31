"""Analytics tap.

Lightweight side consumer that samples SQS messages for downstream analytics.
Reads and logs each record; performs no business processing and no DynamoDB
writes. Kept intentionally cheap so it can coexist with the primary consumer
without contending for its capacity.
"""

import json
import os


def handler(event, context):
    records = event.get("Records", []) if isinstance(event, dict) else []
    sampled = 0
    for r in records:
        body = r.get("body")
        try:
            size = len(body) if isinstance(body, str) else 0
        except Exception:
            size = 0
        print(
            json.dumps(
                {
                    "msg": "analytics_tap_sample",
                    "message_id": r.get("messageId"),
                    "body_bytes": size,
                    "receipt_handle_present": bool(r.get("receiptHandle")),
                }
            )
        )
        sampled += 1
    print(json.dumps({"msg": "analytics_tap_run", "sampled": sampled}))
    return {"sampled": sampled}
