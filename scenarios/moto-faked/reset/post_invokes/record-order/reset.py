"""Data-plane seed/reset for record-order.

Baseline: no ord-1001 item exists, so a no-op agent fails the verifier.
Imported and called first by both pre_invoke and post_invoke; idempotent
and safe to retry.
"""

import os

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
ENDPOINT_URL = os.environ.get("AWS_ENDPOINT_URL") or None
TABLE_NAME = os.environ.get("ORDERS_TABLE", "")

ORDER_ID = "ord-1001"


def reset_data_plane(session=None, region: str = REGION) -> list:
    errors: list = []
    if not TABLE_NAME:
        return ["ORDERS_TABLE is not set"]
    table = (
        (session or boto3.Session())
        .resource("dynamodb", region_name=region, endpoint_url=ENDPOINT_URL)
        .Table(TABLE_NAME)
    )
    try:
        table.delete_item(Key={"orderId": ORDER_ID})
    except ClientError as e:
        errors.append(f"delete {ORDER_ID}: {e}")
    return errors
