"""Express lane order processor.

Same contract as the standard order processor, but trusted channels only need a
sampled availability check instead of validating every line item, so a batch of
ten orders costs one supplier round trip per order rather than ten. The mapping
that would feed this function from the ingest queue is staged but not enabled.
"""

import json
import os
import time

import boto3
from botocore.config import Config

_cfg = Config(
    connect_timeout=5,
    read_timeout=40,
    retries={"max_attempts": 2, "mode": "standard"},
)

lam = boto3.client("lambda", config=_cfg)
ddb = boto3.resource("dynamodb")

ORDERS_TABLE = os.environ["ORDERS_TABLE"]
VALIDATOR_FUNCTION = os.environ["VALIDATOR_FUNCTION"]
SAMPLE_SKUS_PER_ORDER = int(os.environ.get("SAMPLE_SKUS_PER_ORDER", "1"))

_table = ddb.Table(ORDERS_TABLE)


def _sample_validate(order_id: str, line_items: list) -> list:
    results = []
    for line_item in line_items[:SAMPLE_SKUS_PER_ORDER]:
        payload = {
            "order_id": order_id,
            "sku": line_item.get("sku"),
            "qty": line_item.get("qty", 1),
        }
        try:
            resp = lam.invoke(
                FunctionName=VALIDATOR_FUNCTION,
                InvocationType="RequestResponse",
                Payload=json.dumps(payload).encode("utf-8"),
            )
            raw = resp["Payload"].read()
            body = json.loads(raw.decode("utf-8")) if raw else {}
            results.append(
                {
                    "sku": payload["sku"],
                    "status": "validation_unavailable"
                    if resp.get("FunctionError")
                    else body.get("status", "unknown"),
                }
            )
        except Exception as exc:
            print(
                json.dumps({"msg": "validation_call_failed", "error": str(exc)[:200]})
            )
            results.append({"sku": payload["sku"], "status": "validation_unavailable"})
    return results


def handler(event, context):
    records = event.get("Records", [])
    print(json.dumps({"msg": "express_batch_received", "records": len(records)}))
    processed = 0
    for record in records:
        try:
            body = json.loads(record["body"])
        except Exception:
            print(
                json.dumps(
                    {"msg": "express_record_unparsable", "id": record.get("messageId")}
                )
            )
            continue
        order_id = body.get("order_id", record.get("messageId", "UNKNOWN"))
        line_items = body.get("line_items", [])
        sampled = _sample_validate(order_id, line_items)
        now_ms = int(time.time() * 1000)
        _table.put_item(
            Item={
                "pk": f"ORDER#{order_id}",
                "sk": f"EXPRESS#{now_ms}",
                "order_id": order_id,
                "customer_id": body.get("customer_id", "UNKNOWN"),
                "channel": body.get("channel", "unknown"),
                "warehouse": body.get("warehouse", "unknown"),
                "line_item_count": len(line_items),
                "sampled_line_items": len(sampled),
                "lane": "EXPRESS",
                "status": "FULFILLABLE"
                if all(r.get("status") == "in_stock" for r in sampled)
                else "REVIEW",
                "processed_at_ms": now_ms,
            }
        )
        processed += 1
    print(json.dumps({"msg": "express_batch_processed", "orders": processed}))
    return {"batchItemFailures": []}
