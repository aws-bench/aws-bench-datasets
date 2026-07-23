import json
import boto3
import os
from datetime import datetime

dynamodb = boto3.resource("dynamodb")


def handler(event, context):
    """Update tenant record with CloudFront URL"""
    tenant_id = event["tenant_id"]
    table_name = os.environ["TENANTS_TABLE_NAME"]
    distribution_domain = os.environ["DISTRIBUTION_DOMAIN"]

    table = dynamodb.Table(table_name)

    tenant_url = f"https://{distribution_domain}/{tenant_id}/"

    table.update_item(
        Key={"tenant_id": tenant_id},
        UpdateExpression="SET #status = :status, tenant_url = :url, url_configured_at = :timestamp",
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={
            ":status": "URL_CONFIGURED",
            ":url": tenant_url,
            ":timestamp": datetime.utcnow().isoformat(),
        },
    )

    return {"tenant_id": tenant_id, "tenant_url": tenant_url, "url_configured": True}
