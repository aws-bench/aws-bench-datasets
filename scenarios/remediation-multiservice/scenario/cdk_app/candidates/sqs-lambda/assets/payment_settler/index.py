"""Payment settlement consumer (healthy reference pipeline).

Runs with reserved concurrency so settlement never overwhelms the ledger, and a
matching event source mapping scaling ceiling that leaves plenty of headroom.
"""

import json
import os
import time

import boto3

ddb = boto3.resource("dynamodb")
_table = ddb.Table(os.environ["ORDERS_TABLE"])


def handler(event, context):
    settled = 0
    for record in event.get("Records", []):
        try:
            body = json.loads(record["body"])
        except Exception:
            continue
        now_ms = int(time.time() * 1000)
        _table.put_item(
            Item={
                "pk": f"PAYMENT#{body.get('payment_id', record['messageId'])}",
                "sk": f"SETTLED#{now_ms}",
                "order_id": body.get("order_id", "UNKNOWN"),
                "amount_cents": body.get("amount_cents", 0),
                "processor": body.get("processor", "unknown"),
                "status": "SETTLED",
                "settled_at_ms": now_ms,
            }
        )
        settled += 1
    print(json.dumps({"msg": "payments_settled", "count": settled}))
    return {"batchItemFailures": []}
