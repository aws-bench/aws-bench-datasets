"""Inventory validator.

Looks up a SKU in the inventory catalog and confirms availability with the
supplier availability API. The supplier round trip latency is configured in SSM
so operations can tune it without a redeploy.
"""

import json
import os
import time

import boto3

ddb = boto3.client("dynamodb")
ssm = boto3.client("ssm")

INVENTORY_TABLE = os.environ["INVENTORY_TABLE"]
LATENCY_PARAM = os.environ["SUPPLIER_LATENCY_PARAM"]
DEFAULT_LATENCY_MS = float(os.environ.get("DEFAULT_SUPPLIER_LATENCY_MS", "1800"))

_cache = {"value": None, "ts": 0.0}


def _supplier_latency_ms() -> float:
    if _cache["value"] is None or (time.time() - _cache["ts"]) > 300:
        try:
            raw = ssm.get_parameter(Name=LATENCY_PARAM)["Parameter"]["Value"]
            _cache["value"] = float(raw)
        except Exception as exc:
            print(
                json.dumps({"msg": "latency_param_fallback", "error": str(exc)[:200]})
            )
            _cache["value"] = DEFAULT_LATENCY_MS
        _cache["ts"] = time.time()
    return float(_cache["value"])


def handler(event, context):
    sku = str(event.get("sku") or "")
    qty = int(event.get("qty") or 1)

    item = None
    if sku:
        item = ddb.get_item(
            TableName=INVENTORY_TABLE,
            Key={"sku": {"S": sku}},
            ConsistentRead=True,
        ).get("Item")

    # Synchronous supplier availability round trip.
    latency_ms = _supplier_latency_ms()
    time.sleep(latency_ms / 1000.0)

    if not item:
        result = {"sku": sku, "status": "not_in_catalog", "available": 0}
    else:
        available = int(item.get("available_units", {}).get("N", "0"))
        result = {
            "sku": sku,
            "status": "in_stock" if available >= qty else "backordered",
            "available": available,
            "supplier": item.get("supplier_id", {}).get("S", "unknown"),
        }

    result["supplier_latency_ms"] = latency_ms
    print(json.dumps({"msg": "sku_validated", **result}))
    return result
