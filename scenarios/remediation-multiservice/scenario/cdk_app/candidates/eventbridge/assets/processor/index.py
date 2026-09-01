"""Fulfillment event processor.

Receives an already-flattened payload produced by an EventBridge rule input
transformer and writes one enrichment record per event to DynamoDB.

The function is deliberately tolerant of partially populated payloads: upstream
producers roll out new event versions ahead of the pipeline, so missing
attributes fall back to the account-default tier / region rather than failing
the invocation. Every substitution is counted on the FieldDefaultsApplied
custom metric so the data-quality dashboards can track it.
"""

import json
import logging
import os
import time

import boto3

RECORDS_TABLE = os.environ["RECORDS_TABLE"]
TIER_POLICY_TABLE = os.environ["TIER_POLICY_TABLE"]
METRIC_NAMESPACE = os.environ.get("METRIC_NAMESPACE", "Acme/Fulfillment")
PROCESSOR_VERSION = os.environ.get("PROCESSOR_VERSION", "2.4.1")
DEFAULT_CUSTOMER_TIER = os.environ.get("DEFAULT_CUSTOMER_TIER", "STANDARD")
DEFAULT_CUSTOMER_REGION = os.environ.get("DEFAULT_CUSTOMER_REGION", "unknown")
FALLBACK_SLA_HOURS = int(os.environ.get("FALLBACK_SLA_HOURS", "72"))

ddb = boto3.client("dynamodb")
cw = boto3.client("cloudwatch")

LOG = logging.getLogger()
LOG.setLevel(logging.INFO)

# Attributes copied straight through when the transformer supplied them.
OPTIONAL_STRING_FIELDS = (
    "carrier",
    "serviceLevel",
    "destinationCountry",
    "channel",
    "returnReason",
    "warehouseCode",
)


def _scalar(value):
    """Normalise a transformer-supplied scalar.

    EventBridge substitutes an empty value when an input path does not resolve
    against the incoming event, and very old rule versions leave the raw
    ``<variable>`` marker in place. Both mean "not supplied".
    """
    if value is None:
        return ""
    text = str(value).strip()
    if text.startswith("<") and text.endswith(">"):
        return ""
    if text.lower() in ("null", "none", "-"):
        # some producers stringify absent values; treat them as not supplied
        return ""
    return text


def _sla_hours(tier):
    resp = ddb.get_item(
        TableName=TIER_POLICY_TABLE,
        Key={"tier": {"S": tier}},
        ConsistentRead=True,
    )
    item = resp.get("Item")
    if not item or "slaHours" not in item:
        LOG.warning("no SLA policy row for tier=%s, using fallback", tier)
        return FALLBACK_SLA_HOURS
    return int(item["slaHours"]["N"])


def _emit(metric_name, value, event_type):
    cw.put_metric_data(
        Namespace=METRIC_NAMESPACE,
        MetricData=[
            {
                "MetricName": metric_name,
                "Dimensions": [{"Name": "EventType", "Value": event_type or "Unknown"}],
                "Value": float(value),
                "Unit": "Count",
            }
        ],
    )


def _process_one(payload):
    order_id = _scalar(payload.get("orderId")) or "UNKNOWN"
    event_type = _scalar(payload.get("eventType")) or "Unknown"
    occurred_at = _scalar(payload.get("occurredAt")) or "1970-01-01T00:00:00Z"
    source_rule = _scalar(payload.get("sourceRule")) or "unknown-rule"

    defaulted = []

    tier = _scalar(payload.get("customerTier"))
    if not tier:
        tier = DEFAULT_CUSTOMER_TIER
        defaulted.append("customerTier")

    region_label = _scalar(payload.get("customerRegion"))
    if not region_label:
        region_label = DEFAULT_CUSTOMER_REGION
        defaulted.append("customerRegion")

    sla_hours = _sla_hours(tier)

    item = {
        "orderId": {"S": order_id},
        "eventKey": {"S": "{}#{}".format(event_type, occurred_at)},
        "eventType": {"S": event_type},
        "occurredAt": {"S": occurred_at},
        "customerTier": {"S": tier},
        "customerRegion": {"S": region_label},
        "slaHours": {"N": str(sla_hours)},
        "sourceRule": {"S": source_rule},
        "processorVersion": {"S": PROCESSOR_VERSION},
        "processedAt": {"N": str(int(time.time()))},
        "payloadKeyCount": {"N": str(len(payload))},
    }
    for field in OPTIONAL_STRING_FIELDS:
        value = _scalar(payload.get(field))
        if value:
            item[field] = {"S": value}

    ddb.put_item(TableName=RECORDS_TABLE, Item=item)

    _emit("RecordsWritten", 1, event_type)
    _emit("FieldDefaultsApplied", len(defaulted), event_type)

    LOG.info(
        "PROCESSED %s",
        json.dumps(
            {
                "orderId": order_id,
                "eventType": event_type,
                "sourceRule": source_rule,
                "customerTier": tier,
                "customerRegion": region_label,
                "slaHours": sla_hours,
                "payloadKeys": sorted(payload.keys()),
            },
            sort_keys=True,
        ),
    )
    return {"orderId": order_id, "eventType": event_type, "slaHours": sla_hours}


def handler(event, context):
    payloads = event if isinstance(event, list) else [event]
    results = [_process_one(p) for p in payloads if isinstance(p, dict)]
    return {"status": "ok", "processed": len(results), "records": results}
