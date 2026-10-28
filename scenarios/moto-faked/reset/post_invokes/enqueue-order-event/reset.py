"""Data-plane seed/reset for enqueue-order-event.

Baseline: the order-events queue is empty (purged), so a no-op agent fails
the verifier. Imported and called first by both pre_invoke and post_invoke;
idempotent and safe to retry.
"""

import os
import time

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
ENDPOINT_URL = os.environ.get("AWS_ENDPOINT_URL") or None
QUEUE_URL = os.environ.get("ORDER_QUEUE_URL", "")


def _drain(sqs, errors: list) -> None:
    """Receive-and-delete fallback: purge is throttled to one call per 60s
    on real AWS, so a retry inside that window must drain instead."""
    try:
        for _ in range(10):
            resp = sqs.receive_message(
                QueueUrl=QUEUE_URL,
                MaxNumberOfMessages=10,
                VisibilityTimeout=0,
            )
            batch = resp.get("Messages", [])
            if not batch:
                return
            sqs.delete_message_batch(
                QueueUrl=QUEUE_URL,
                Entries=[
                    {"Id": str(i), "ReceiptHandle": m["ReceiptHandle"]}
                    for i, m in enumerate(batch)
                ],
            )
    except ClientError as e:
        errors.append(f"drain queue: {e}")


def reset_data_plane(session=None, region: str = REGION) -> list:
    errors: list = []
    if not QUEUE_URL:
        return ["ORDER_QUEUE_URL is not set"]
    sqs = (session or boto3.Session()).client(
        "sqs", region_name=region, endpoint_url=ENDPOINT_URL
    )
    try:
        sqs.purge_queue(QueueUrl=QUEUE_URL)
        # Purge is eventually consistent on real AWS; moto applies it
        # immediately, but the pause keeps behavior identical everywhere.
        time.sleep(1)
    except ClientError as e:
        if "PurgeQueueInProgress" not in str(e):
            errors.append(f"purge queue: {e}")
        _drain(sqs, errors)
    return errors
