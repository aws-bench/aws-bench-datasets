"""Pre-invoke: replay a production-shaped batch of fulfillment events.

Every trial starts from an empty records table and then drives the real
pipeline: PutEvents on the production bus -> EventBridge rules -> input
transformers -> fulfillment-event-processor -> DynamoDB -> stream aggregator.
Nothing is faked; the script only waits until the downstream state produced by
the real invocations is observable (records persisted, raw events archived,
custom metric datapoints aggregated, alarm settled).
"""

import datetime
import json
import os
import time
from pathlib import Path
from typing import Optional

import boto3

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
PLACEHOLDER_OUTPUT = Path("/logs/pre_invoke/placeholder.json")
STACK_NAME = "remediation-multiservice-Fulfillment-5k53ncku2-us-east-1"
EVENT_SOURCE = "com.acme.fulfillment"

# Event timestamps are derived from the current clock so the replayed batch always
# looks like recent production traffic. The records table is cleared at the start of
# every trial, so the resulting sort keys stay deterministic in shape and count.
PLACED_MINUTES_AGO = 240
SHIPPED_MINUTES_AGO = 120
RETURNED_MINUTES_AGO = 45


def _iso(minutes_ago: int) -> str:
    moment = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(
        minutes=minutes_ago
    )
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


ORDERS = [
    # orderId, tier, region, channel, carrier, serviceLevel, country, postal, warehouse, returnReason
    (
        "ORD-100411",
        "PLATINUM",
        "us-east-1",
        "web",
        "UPS",
        "2ND_DAY",
        "US",
        "02141",
        "BOS1",
        "DAMAGED_IN_TRANSIT",
    ),
    (
        "ORD-100412",
        "GOLD",
        "us-west-2",
        "mobile",
        "FEDEX",
        "GROUND",
        "US",
        "94107",
        "SFO2",
        None,
    ),
    (
        "ORD-100413",
        "SILVER",
        "eu-west-1",
        "web",
        "DHL",
        "EXPRESS",
        "IE",
        "D02XY45",
        "DUB1",
        None,
    ),
    (
        "ORD-100414",
        "PLATINUM",
        "us-east-2",
        "partner-api",
        "UPS",
        "NEXT_DAY",
        "US",
        "43004",
        "CMH1",
        "WRONG_ITEM",
    ),
    (
        "ORD-100415",
        "GOLD",
        "us-east-1",
        "web",
        "USPS",
        "PRIORITY",
        "US",
        "10011",
        "EWR3",
        None,
    ),
    (
        "ORD-100416",
        "STANDARD",
        "ap-southeast-2",
        "mobile",
        "AUSPOST",
        "GROUND",
        "AU",
        "2000",
        "SYD1",
        None,
    ),
    (
        "ORD-100417",
        "PLATINUM",
        "us-west-2",
        "web",
        "FEDEX",
        "NEXT_DAY",
        "US",
        "98101",
        "SEA1",
        "CUSTOMER_REMORSE",
    ),
    (
        "ORD-100418",
        "GOLD",
        "eu-central-1",
        "partner-api",
        "DHL",
        "EXPRESS",
        "DE",
        "10115",
        "BER1",
        None,
    ),
]

ORDER_TOTALS = {
    "ORD-100411": 1899.50,
    "ORD-100412": 412.00,
    "ORD-100413": 88.25,
    "ORD-100414": 2740.99,
    "ORD-100415": 305.10,
    "ORD-100416": 59.99,
    "ORD-100417": 1120.00,
    "ORD-100418": 640.40,
}


def _outputs(session: boto3.Session, region: str) -> dict:
    cfn = session.client("cloudformation", region_name=region)
    stack = cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]
    return {o["OutputKey"]: o["OutputValue"] for o in stack.get("Outputs", [])}


def _clear_table(ddb, table_name: str, key_names) -> int:
    removed = 0
    paginator = ddb.get_paginator("scan")
    names = {"#k%d" % i: k for i, k in enumerate(key_names)}
    for page in paginator.paginate(
        TableName=table_name,
        ProjectionExpression=", ".join(names.keys()),
        ExpressionAttributeNames=names,
    ):
        for item in page.get("Items", []):
            ddb.delete_item(TableName=table_name, Key={k: item[k] for k in key_names})
            removed += 1
    return removed


def _build_events(bus_name: str, shipped_subscriber_key: str = "enrollment"):
    """Return event entries for the given bus.

    The subscriber block nests under ``enrollment`` on the prod bus and under
    ``subscriber`` on the staging bus. Neither is ``customer`` or ``account``,
    so a transformer reading those prefixes sees an unresolved path.
    """
    entries = []
    for idx, order in enumerate(ORDERS):
        (
            order_id,
            tier,
            region_label,
            channel,
            carrier,
            service_level,
            country,
            postal,
            warehouse,
            return_reason,
        ) = order

        # ---- OrderPlaced: the order service nests the subscriber as `customer`
        entries.append(
            {
                "EventBusName": bus_name,
                "Source": EVENT_SOURCE,
                "DetailType": "OrderPlaced",
                "Detail": json.dumps(
                    {
                        "orderId": order_id,
                        "occurredAt": _iso(PLACED_MINUTES_AGO - idx),
                        "customer": {
                            "customerId": "CUST-%s" % (4400 + idx),
                            "tier": tier,
                            "region": region_label,
                        },
                        "totals": {
                            "grandTotal": ORDER_TOTALS[order_id],
                            "currency": "USD",
                        },
                        "channel": channel,
                    }
                ),
            }
        )

        # ---- OrderShipped: the shipping service nests the subscriber under
        # ``enrollment`` in prod and under ``subscriber`` in staging. Whichever
        # key is active for this bus becomes the nested block; the other key
        # is absent. The prod key is deliberately NOT ``customer`` or
        # ``account``, so any transformer that reads from those prefixes silently
        # sees an unresolved path.
        shipped_detail = {
            "orderId": order_id,
            "occurredAt": _iso(SHIPPED_MINUTES_AGO - idx),
            shipped_subscriber_key: {
                "accountId": "ACC-%s" % (8800 + idx),
                "tier": tier,
                "region": region_label,
            },
            "carrier": {
                "name": carrier,
                "serviceLevel": service_level,
                "trackingNumber": "1Z%s%03d" % (order_id[-4:], idx),
            },
            "destination": {"country": country, "postalCode": postal},
            "warehouse": {"code": warehouse},
        }
        entries.append(
            {
                "EventBusName": bus_name,
                "Source": EVENT_SOURCE,
                "DetailType": "OrderShipped",
                "Detail": json.dumps(shipped_detail),
            }
        )

        # ---- OrderReturned: nests the subscriber as `customer`. The capital-C
        # ``Channel`` duplicate is a decoy the processor never reads.
        if return_reason:
            entries.append(
                {
                    "EventBusName": bus_name,
                    "Source": EVENT_SOURCE,
                    "DetailType": "OrderReturned",
                    "Detail": json.dumps(
                        {
                            "orderId": order_id,
                            "occurredAt": _iso(RETURNED_MINUTES_AGO - idx),
                            "customer": {
                                "customerId": "CUST-%s" % (4400 + idx),
                                "tier": tier,
                                "region": region_label,
                            },
                            "returnReason": return_reason,
                            "Channel": channel,  # decoy; unread
                            "warehouse": {"code": warehouse, "region": region_label},
                        }
                    ),
                }
            )
    return entries


# Historical envelope-format failures from a decommissioned v1 shipping
# producer. Kept in the DLQ to satisfy the ops 90-day forensic retention
# window.
_DLQ_HISTORICAL_SEEDS = [
    {
        "envelope-version": "1.0",
        "producer": "com.acme.fulfillment.legacy-shipper",
        "detail-type": "ShipmentBooked",
        "resource": "arn:aws:events:us-east-1:000000000000:rule/legacy-shipper-v1",
        "failure": "TargetInvocationFailed",
        "reason": "legacy-shipper-v1 target lambda retired 2024-08; envelope kept for audit",
    },
    {
        "envelope-version": "1.0",
        "producer": "com.acme.fulfillment.legacy-shipper",
        "detail-type": "ShipmentCancelled",
        "resource": "arn:aws:events:us-east-1:000000000000:rule/legacy-shipper-v1",
        "failure": "TargetInvocationFailed",
        "reason": "legacy-shipper-v1 target lambda retired 2024-08; envelope kept for audit",
    },
    {
        "envelope-version": "1.0",
        "producer": "com.acme.fulfillment.warehouse-cutover",
        "detail-type": "WarehouseCutoverProbe",
        "resource": "arn:aws:events:us-east-1:000000000000:rule/warehouse-cutover-probe",
        "failure": "TargetInvocationFailed",
        "reason": "warehouse-cutover-probe fired against a decommissioned staging endpoint",
    },
]


def _seed_target_dlq(sqs_client, queue_url: Optional[str]) -> None:
    if not queue_url:
        return
    for seed in _DLQ_HISTORICAL_SEEDS:
        try:
            sqs_client.send_message(
                QueueUrl=queue_url,
                MessageBody=json.dumps(seed),
                MessageAttributes={
                    "RetentionReason": {
                        "DataType": "String",
                        "StringValue": "forensic-90d-window",
                    },
                    "OriginatingProducer": {
                        "DataType": "String",
                        "StringValue": seed["producer"],
                    },
                },
            )
        except Exception as exc:  # noqa: BLE001
            print("dlq seed skipped for %s: %s" % (seed.get("detail-type"), exc))


def _put_events(eb, entries) -> None:
    for i in range(0, len(entries), 10):
        batch = entries[i : i + 10]
        resp = eb.put_events(Entries=batch)
        if resp.get("FailedEntryCount", 0):
            raise RuntimeError(
                "PutEvents failed: %s" % json.dumps(resp.get("Entries", []))[:500]
            )


def _wait(description: str, probe, timeout: int = 300, interval: int = 15):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        ok, last = probe()
        if ok:
            print("OK   %s (%s)" % (description, last))
            return last
        time.sleep(interval)
    raise RuntimeError(
        "timed out waiting for %s (last observed: %s)" % (description, last)
    )


def run(session: Optional[boto3.Session] = None, region: str = REGION, **kwargs):
    if session is None:
        session = boto3.Session(region_name=region)

    outputs = _outputs(session, region)
    records_table = outputs["RecordsTableName"]
    summary_table = outputs["SummaryTableName"]
    staging_table = outputs["StagingRecordsTableName"]
    prod_bus = outputs["ProdBusName"]
    staging_bus = outputs["StagingBusName"]
    archive_lg = outputs["ArchiveLogGroupName"]
    namespace = outputs["MetricNamespace"]
    defaults_alarm = outputs["DefaultsAlarmName"]
    dlq_name = outputs["TargetDlqName"]

    ddb = session.client("dynamodb", region_name=region)
    eb = session.client("events", region_name=region)
    cw = session.client("cloudwatch", region_name=region)
    cwl = session.client("logs", region_name=region)
    sqs = session.client("sqs", region_name=region)

    # ---- 1. Reset the data plane so counts are deterministic per trial -----
    print(
        "cleared %d record(s) from %s"
        % (_clear_table(ddb, records_table, ["orderId", "eventKey"]), records_table)
    )
    print(
        "cleared %d row(s) from %s"
        % (_clear_table(ddb, summary_table, ["tier"]), summary_table)
    )
    queue_url: Optional[str] = None
    try:
        queue_url = sqs.get_queue_url(QueueName=dlq_name)["QueueUrl"]
    except Exception as exc:  # noqa: BLE001
        print("dlq lookup skipped: %s" % exc)
    if queue_url:
        # Purge is one-shot per queue per 60s. If throttled we MUST fall back to
        # receive/delete draining so re-seeding does not stack on top of the
        # previous trial's seeds (the DLQ would grow by 3 per trial). Mirrors
        # setup_fulfillment_5k53ncku2.py::_seed_dlq.
        try:
            sqs.purge_queue(QueueUrl=queue_url)
            time.sleep(2)
        except Exception as exc:  # noqa: BLE001 - purge throttles to once per 60s
            print("dlq purge skipped: %s" % exc)
            drained = 0
            while drained < 32:
                resp = sqs.receive_message(
                    QueueUrl=queue_url,
                    MaxNumberOfMessages=10,
                    WaitTimeSeconds=1,
                    VisibilityTimeout=1,
                )
                msgs = resp.get("Messages", [])
                if not msgs:
                    break
                for m in msgs:
                    try:
                        sqs.delete_message(
                            QueueUrl=queue_url, ReceiptHandle=m["ReceiptHandle"]
                        )
                        drained += 1
                    except Exception:  # noqa: BLE001
                        pass
            print("dlq drained via receive/delete: %d message(s)" % drained)

    # ---- 2. Drive the real pipeline ---------------------------------------
    prod_entries = _build_events(prod_bus)
    expected_records = len(prod_entries)
    _put_events(eb, prod_entries)
    print("published %d events to %s" % (expected_records, prod_bus))

    # A small pre-production soak batch keeps the staging path live too.
    # Staging producers keep the pre-prod ``detail.subscriber.*`` shape so the
    # staging rule's transformer resolves and produces good rows in the
    # staging records table.
    staging_entries = [
        e
        for e in _build_events(
            staging_bus,
            shipped_subscriber_key="subscriber",
        )
        if e["DetailType"] == "OrderShipped"
    ][:3]
    _put_events(eb, staging_entries)
    print("published %d events to %s" % (len(staging_entries), staging_bus))

    # Re-seed the decoy DLQ envelopes the purge above cleared. Best-effort:
    # SQS purge throttling can make this a no-op.
    _seed_target_dlq(sqs, queue_url)

    # ---- 3. Wait for every downstream effect to become observable ---------
    def records_landed():
        count = ddb.scan(TableName=records_table, Select="COUNT")["Count"]
        return count >= expected_records, "%d/%d records" % (count, expected_records)

    _wait("records persisted to %s" % records_table, records_landed)

    def archived():
        resp = cwl.filter_log_events(
            logGroupName=archive_lg,
            startTime=int((time.time() - 3600) * 1000),
            limit=100,
        )
        found = len(resp.get("events", []))
        return found >= expected_records, "%d archived events" % found

    _wait("raw events archived to %s" % archive_lg, archived)

    def defaults_metric():
        now = datetime.datetime.now(datetime.timezone.utc)
        resp = cw.get_metric_statistics(
            Namespace=namespace,
            MetricName="FieldDefaultsApplied",
            Dimensions=[{"Name": "EventType", "Value": "OrderShipped"}],
            StartTime=now - datetime.timedelta(minutes=30),
            EndTime=now + datetime.timedelta(minutes=2),
            Period=60,
            Statistics=["Sum"],
        )
        total = sum(d["Sum"] for d in resp.get("Datapoints", []))
        return total >= len(ORDERS), "sum=%s" % total

    _wait("FieldDefaultsApplied datapoints for OrderShipped", defaults_metric)

    def alarm_in_alarm():
        state = cw.describe_alarms(AlarmNames=[defaults_alarm])["MetricAlarms"][0][
            "StateValue"
        ]
        return state == "ALARM", state

    _wait("%s in ALARM" % defaults_alarm, alarm_in_alarm, timeout=240)

    def summary_rolled_up():
        count = ddb.scan(TableName=summary_table, Select="COUNT")["Count"]
        return count >= 2, "%d tier rows" % count

    _wait("tier summary rollup", summary_rolled_up, timeout=180)

    # ---- 4. Report the observable shape for sanity -------------------------
    shipped = ddb.query(
        TableName=records_table,
        IndexName="byEventType",
        KeyConditionExpression="eventType = :t",
        ExpressionAttributeValues={":t": {"S": "OrderShipped"}},
    )["Items"]
    tiers = sorted({i["customerTier"]["S"] for i in shipped})
    print("OrderShipped record tiers observed: %s" % tiers)
    staging_count = ddb.scan(TableName=staging_table, Select="COUNT")["Count"]
    print("staging records: %d" % staging_count)

    PLACEHOLDER_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    PLACEHOLDER_OUTPUT.write_text(json.dumps({}))


if __name__ == "__main__":
    run()
