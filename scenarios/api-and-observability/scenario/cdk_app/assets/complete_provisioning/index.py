import json
import boto3
import os
from datetime import datetime

dynamodb = boto3.resource("dynamodb")


def handler(event, context):
    """Complete tenant provisioning"""
    tenant_id = event["tenant_id"]
    table_name = os.environ["TENANTS_TABLE_NAME"]

    table = dynamodb.Table(table_name)

    table.update_item(
        Key={"tenant_id": tenant_id},
        UpdateExpression="SET #status = :status, provisioned_at = :timestamp",
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={
            ":status": "PROVISIONED",
            ":timestamp": datetime.utcnow().isoformat(),
        },
    )

    return {"tenant_id": tenant_id, "provisioning_complete": True}
