"""Order processor.

Consumes order events from the ingest queue, validates every line item against
the inventory service, and persists the processed order.
"""

import json
import os
import time

import boto3
from botocore.config import Config

_cfg = Config(
    connect_timeout=5,
    read_timeout=70,
    retries={"max_attempts": 3, "mode": "standard"},
)

lam = boto3.client("lambda", config=_cfg)
ddb = boto3.resource("dynamodb")

ORDERS_TABLE = os.environ["ORDERS_TABLE"]
VALIDATOR_FUNCTION = os.environ["VALIDATOR_FUNCTION"]

_table = ddb.Table(ORDERS_TABLE)


def _validate_line_item(order_id: str, line_item: dict) -> dict:
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
        if resp.get("FunctionError"):
            return {"sku": payload["sku"], "status": "validation_unavailable"}
        return {
            "sku": payload["sku"],
            "status": body.get("status", "unknown"),
            "available": body.get("available", 0),
        }
    except Exception as exc:  # inventory service degraded -> ship as unverified
        print(json.dumps({"msg": "validation_call_failed", "error": str(exc)[:200]}))
        return {"sku": payload["sku"], "status": "validation_unavailable"}


def _process(record: dict) -> None:
    started = time.time()
    body = json.loads(record["body"])
    order_id = body.get("order_id", "UNKNOWN")
    line_items = body.get("line_items", [])

    results = [_validate_line_item(order_id, li) for li in line_items]
    in_stock = sum(1 for r in results if r.get("status") == "in_stock")

    now_ms = int(time.time() * 1000)
    _table.put_item(
        Item={
            "pk": f"ORDER#{order_id}",
            "sk": f"PROCESSED#{now_ms}",
            "order_id": order_id,
            "customer_id": body.get("customer_id", "UNKNOWN"),
            "channel": body.get("channel", "unknown"),
            "warehouse": body.get("warehouse", "unknown"),
            "line_item_count": len(line_items),
            "line_items_in_stock": in_stock,
            "status": "FULFILLABLE" if in_stock == len(line_items) else "PARTIAL",
            "processed_at_ms": now_ms,
        }
    )

    elapsed_ms = int((time.time() - started) * 1000)
    print(
        json.dumps(
            {
                "msg": "order_processed",
                "order_id": order_id,
                "line_items": len(line_items),
                "validator_calls": len(results),
                "in_stock": in_stock,
                "elapsed_ms": elapsed_ms,
                "enqueued_at": record.get("attributes", {}).get("SentTimestamp"),
            }
        )
    )


def handler(event, context):
    batch_item_failures = []
    records = event.get("Records", [])
    print(json.dumps({"msg": "batch_received", "records": len(records)}))
    for record in records:
        try:
            _process(record)
        except Exception as exc:
            # Malformed payloads are parked, never retried forever.
            print(
                json.dumps(
                    {
                        "msg": "record_parked",
                        "message_id": record.get("messageId"),
                        "error": str(exc)[:300],
                    }
                )
            )
    return {"batchItemFailures": batch_item_failures}
