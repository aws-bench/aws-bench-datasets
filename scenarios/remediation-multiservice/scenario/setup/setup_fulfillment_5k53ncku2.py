"""Post-deploy seeding for the fulfillment event pipeline.

Seeds:
  * fulfillment-tier-policy  - the SLA policy rows the processor Lambda reads
  * fulfillment-event-records-staging - the pre-production validation baseline
  * fulfillment-eventbridge-target-dlq - historical envelope-format messages
    left over from a decommissioned v1 shipping producer.

Idempotent: every row is written with put_item, the staging baseline is
cleared before it is re-written, and DLQ seeds are re-published on each run.
All timestamps are derived from the current clock so the seeded state never
reads as stale.
"""

import datetime
import json
import time
from typing import Optional

import boto3

REGION = "us-east-1"
STACK_NAME = "remediation-multiservice-Fulfillment-5k53ncku2-us-east-1"

# tier -> (slaHours, escalationMinutes, description)
TIER_POLICY = [
    ("PLATINUM", 4, 15, "Named-account contractual SLA - 4h fulfillment promise"),
    ("GOLD", 12, 60, "Subscription tier - 12h fulfillment promise"),
    ("SILVER", 24, 240, "Subscription tier - next business day"),
    ("STANDARD", 48, 720, "Default retail tier - 48h fulfillment promise"),
]

# Baseline rows produced by the staging pipeline during the 2.5.0-rc1 soak test.
# minutesAgo keeps the original relative ordering/spacing of the three rows.
STAGING_BASELINE = [
    # minutesAgo, orderId, eventType, tier, region, slaHours, carrier, country
    (185, "ORD-900001", "OrderShipped", "PLATINUM", "us-east-1", 4, "UPS", "US"),
    (159, "ORD-900002", "OrderShipped", "GOLD", "us-west-2", 12, "FEDEX", "US"),
    (138, "ORD-900003", "OrderShipped", "SILVER", "eu-west-1", 24, "DHL", "IE"),
]


def _iso(minutes_ago: int) -> str:
    moment = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(
        minutes=minutes_ago
    )
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _outputs(session: boto3.Session, region: str) -> dict:
    cfn = session.client("cloudformation", region_name=region)
    stacks = cfn.describe_stacks(StackName=STACK_NAME)["Stacks"]
    return {o["OutputKey"]: o["OutputValue"] for o in stacks[0].get("Outputs", [])}


# Re-seeded on every run so the DLQ inventory is stable.
DLQ_HISTORICAL_SEEDS = [
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


def _seed_dlq(session: boto3.Session, region: str, dlq_name: str) -> int:
    sqs = session.client("sqs", region_name=region)
    try:
        queue_url = sqs.get_queue_url(QueueName=dlq_name)["QueueUrl"]
    except sqs.exceptions.QueueDoesNotExist:
        print("dlq %s does not exist yet, skipping seed" % dlq_name)
        return 0

    # Best-effort purge. Purge throttles to once per 60s; if it fails, delete
    # any existing seeds by-message so the trial always sees the same count.
    try:
        sqs.purge_queue(QueueUrl=queue_url)
        time.sleep(2)
    except Exception as exc:  # noqa: BLE001
        print("dlq purge skipped: %s" % exc)
        # Drain any lingering seeds via receive/delete so we don't stack them.
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

    seeded = 0
    for seed in DLQ_HISTORICAL_SEEDS:
        sqs.send_message(
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
        seeded += 1
    return seeded


def _clear_table(ddb, table_name: str, key_names) -> None:
    paginator = ddb.get_paginator("scan")
    names = {"#k%d" % i: k for i, k in enumerate(key_names)}
    for page in paginator.paginate(
        TableName=table_name,
        ProjectionExpression=", ".join(names.keys()),
        ExpressionAttributeNames=names,
    ):
        for item in page.get("Items", []):
            ddb.delete_item(TableName=table_name, Key={k: item[k] for k in key_names})


def run(session: Optional[boto3.Session] = None, region: str = REGION, **kwargs):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY")

    outputs = _outputs(session, region)
    policy_table = outputs["TierPolicyTableName"]
    staging_table = outputs["StagingRecordsTableName"]

    ddb = session.client("dynamodb", region_name=region)

    for tier, sla_hours, escalation, description in TIER_POLICY:
        ddb.put_item(
            TableName=policy_table,
            Item={
                "tier": {"S": tier},
                "slaHours": {"N": str(sla_hours)},
                "escalationMinutes": {"N": str(escalation)},
                "description": {"S": description},
                "updatedAt": {"N": str(int(time.time()))},
            },
        )
    print("seeded %d tier policy rows into %s" % (len(TIER_POLICY), policy_table))

    _clear_table(ddb, staging_table, ["orderId", "eventKey"])
    for (
        minutes_ago,
        order_id,
        event_type,
        tier,
        region_label,
        sla,
        carrier,
        country,
    ) in STAGING_BASELINE:
        occurred_at = _iso(minutes_ago)
        ddb.put_item(
            TableName=staging_table,
            Item={
                "orderId": {"S": order_id},
                "eventKey": {"S": "%s#%s" % (event_type, occurred_at)},
                "eventType": {"S": event_type},
                "occurredAt": {"S": occurred_at},
                "customerTier": {"S": tier},
                "customerRegion": {"S": region_label},
                "slaHours": {"N": str(sla)},
                "carrier": {"S": carrier},
                "destinationCountry": {"S": country},
                "sourceRule": {"S": outputs["ShippedRuleName"]},
                "processorVersion": {"S": "2.5.0-rc1"},
                "processedAt": {"N": str(int(time.time()))},
            },
        )
    print(
        "seeded %d staging baseline rows into %s"
        % (len(STAGING_BASELINE), staging_table)
    )

    # Sanity check: the processor cannot compute an SLA without these rows.
    got = ddb.get_item(
        TableName=policy_table, Key={"tier": {"S": "PLATINUM"}}, ConsistentRead=True
    )
    if "Item" not in got:
        raise RuntimeError("tier policy seeding did not persist")

    dlq_name = outputs.get("TargetDlqName")
    if dlq_name:
        seeded = _seed_dlq(session, region, dlq_name)
        print("seeded %d historical envelope row(s) into %s" % (seeded, dlq_name))


if __name__ == "__main__":
    run()
