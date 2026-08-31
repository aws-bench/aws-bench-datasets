"""Seed the order ingest platform with production-shaped catalog and history data.

Runs once after `cdk deploy`. The EventBridge schedule already drives live
traffic, so this script only needs to (a) seed the inventory catalog the
validator reads, (b) backfill processing history for both lanes, and (c) block
until the pipeline is demonstrably wired end to end and the ingest queue has
started building a backlog.
"""

from typing import Optional
import time

import boto3
from botocore.exceptions import ClientError

REGION = "us-east-1"
STACK_NAME = "remediation-multiservice-Ingest-ay9wdpt5n-us-east-1"

SUPPLIERS = ["acme-supply", "northstar-dist", "vertex-goods", "harborline"]
CATEGORIES = ["apparel", "home", "electronics", "outdoor", "grocery"]

PRIME_BATCHES = 4


def _outputs(cfn, stack_name: str) -> dict:
    stacks = cfn.describe_stacks(StackName=stack_name)["Stacks"]
    return {o["OutputKey"]: o["OutputValue"] for o in stacks[0].get("Outputs", [])}


def _seed_inventory(ddb, table_name: str) -> int:
    count = 0
    with ddb.Table(table_name).batch_writer(overwrite_by_pkeys=["sku"]) as batch:
        for i in range(40):
            sku = f"SKU-{1000 + i}"
            batch.put_item(
                Item={
                    "sku": sku,
                    "description": f"{CATEGORIES[i % len(CATEGORIES)]} item {1000 + i}",
                    "category": CATEGORIES[i % len(CATEGORIES)],
                    "supplier_id": SUPPLIERS[i % len(SUPPLIERS)],
                    "available_units": 250 + (i * 17) % 900,
                    "reorder_point": 40 + (i % 5) * 10,
                    "unit_cost_cents": 800 + (i * 31) % 4000,
                }
            )
            count += 1
    return count


def _seed_history(ddb, orders_table: str, notifications_table: str) -> None:
    """Backfill yesterday's processed orders / notifications so the tables look
    like a system that has been running, not a fresh deploy."""
    now_ms = int(time.time() * 1000)
    day_ms = 86_400_000
    with ddb.Table(orders_table).batch_writer(overwrite_by_pkeys=["pk", "sk"]) as batch:
        for i in range(60):
            ts = now_ms - day_ms + i * 60_000
            batch.put_item(
                Item={
                    "pk": f"ORDER#ORD-HIST-{i:04d}",
                    "sk": f"PROCESSED#{ts}",
                    "order_id": f"ORD-HIST-{i:04d}",
                    "customer_id": f"CUST-{i * 7 % 5000:05d}",
                    "channel": ["web", "ios", "android", "partner-api"][i % 4],
                    "warehouse": ["ORD1", "DFW2", "EWR3"][i % 3],
                    "line_item_count": 10,
                    "line_items_in_stock": 10,
                    "status": "FULFILLABLE",
                    "processed_at_ms": ts,
                }
            )
        # Express lane pilot history from the cut over rehearsal that never shipped.
        for i in range(12):
            ts = now_ms - 3 * day_ms + i * 60_000
            batch.put_item(
                Item={
                    "pk": f"ORDER#ORD-XPRESS-{i:04d}",
                    "sk": f"EXPRESS#{ts}",
                    "order_id": f"ORD-XPRESS-{i:04d}",
                    "customer_id": f"CUST-{i * 13 % 5000:05d}",
                    "channel": "partner-api",
                    "warehouse": "ORD1",
                    "line_item_count": 10,
                    "sampled_line_items": 1,
                    "lane": "EXPRESS",
                    "status": "FULFILLABLE",
                    "processed_at_ms": ts,
                }
            )
        for i in range(20):
            ts = now_ms - day_ms + i * 90_000
            batch.put_item(
                Item={
                    "pk": f"PAYMENT#PAY-HIST-{i:04d}",
                    "sk": f"SETTLED#{ts}",
                    "order_id": f"ORD-HIST-{i:04d}",
                    "amount_cents": 5000 + i * 250,
                    "processor": "stripe" if i % 2 == 0 else "adyen",
                    "status": "SETTLED",
                    "settled_at_ms": ts,
                }
            )
    with ddb.Table(notifications_table).batch_writer(
        overwrite_by_pkeys=["notification_id", "delivered_at_ms"]
    ) as batch:
        for i in range(40):
            ts = now_ms - day_ms + i * 45_000
            batch.put_item(
                Item={
                    "notification_id": f"NTF-HIST-{i:04d}",
                    "delivered_at_ms": ts,
                    "template": "order_received",
                    "customer_id": f"CUST-{i * 11 % 5000:05d}",
                    "channel": ["web", "ios", "android", "partner-api"][i % 4],
                    "status": "DELIVERED",
                }
            )


def _wait_for_pipeline(
    sqs, lam, queue_url: str, queue_arn: str, deadline_s: int = 300
) -> None:
    """Block until the ingest schedule has an enabled consumer mapping and the
    pipeline has demonstrably moved messages through the queue."""
    deadline = time.time() + deadline_s
    esm_enabled = False
    backlog = 0
    inflight = 0
    while time.time() < deadline:
        if not esm_enabled:
            mappings = lam.list_event_source_mappings(EventSourceArn=queue_arn).get(
                "EventSourceMappings", []
            )
            esm_enabled = any(m.get("State") == "Enabled" for m in mappings)
        attrs = sqs.get_queue_attributes(
            QueueUrl=queue_url,
            AttributeNames=[
                "ApproximateNumberOfMessages",
                "ApproximateNumberOfMessagesNotVisible",
            ],
        )["Attributes"]
        backlog = int(attrs["ApproximateNumberOfMessages"])
        inflight = int(attrs["ApproximateNumberOfMessagesNotVisible"])
        if esm_enabled and (backlog + inflight) >= 1:
            print(
                f"pipeline live: esm_enabled=True visible={backlog} not_visible={inflight}"
            )
            return
        time.sleep(15)
    raise RuntimeError(
        f"pipeline never reached a steady backlog (esm_enabled={esm_enabled}, visible={backlog})"
    )


def run(session: Optional[boto3.Session] = None, region: str = REGION, **kwargs):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY")

    cfn = session.client("cloudformation", region_name=region)
    ddb = session.resource("dynamodb", region_name=region)
    sqs = session.client("sqs", region_name=region)
    lam = session.client("lambda", region_name=region)

    out = _outputs(cfn, STACK_NAME)
    inventory_table = out["InventoryTableName"]
    orders_table = out["OrdersTableName"]
    notifications_table = out["NotificationsTableName"]
    queue_url = out["OrdersQueueUrl"]
    queue_arn = out["OrdersQueueArn"]

    seeded = _seed_inventory(ddb, inventory_table)
    print(f"seeded {seeded} SKUs into {inventory_table}")

    _seed_history(ddb, orders_table, notifications_table)
    print(f"backfilled processing history into {orders_table} / {notifications_table}")

    # Prime the pipeline immediately instead of waiting for the next schedule tick.
    for i in range(PRIME_BATCHES):
        try:
            lam.invoke(
                FunctionName=out["GatewayFunctionName"],
                InvocationType="RequestResponse",
            )
        except ClientError as exc:
            print(f"gateway prime invoke {i} failed, relying on schedule: {exc}")

    _wait_for_pipeline(sqs, lam, queue_url, queue_arn)
    print("setup complete")


if __name__ == "__main__":
    run()
