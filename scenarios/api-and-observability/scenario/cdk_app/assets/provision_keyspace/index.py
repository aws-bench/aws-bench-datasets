import json
import boto3
import os
from datetime import datetime

s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")


def handler(event, context):
    """Provision S3 keyspace for tenant"""
    tenant_id = event["tenant_id"]
    table_name = os.environ["TENANTS_TABLE_NAME"]
    bucket_name = os.environ["TENANT_SERVICES_BUCKET"]

    table = dynamodb.Table(table_name)

    # Create tenant keyspace (folder) in S3 with sample files
    index_html = f"""<!DOCTYPE html>
<html>
<head>
    <title>Tenant: {tenant_id}</title>
    <script src="app.js"></script>
</head>
<body>
    <h1>Welcome to {tenant_id}</h1>
    <p>This is your tenant application.</p>
    <div id="tenant-info"></div>
</body>
</html>"""

    app_js = f"""
document.addEventListener('DOMContentLoaded', function() {{
    document.getElementById('tenant-info').innerHTML = 
        '<p>Tenant ID: {tenant_id}</p>' +
        '<p>Loaded at: ' + new Date().toISOString() + '</p>';
}});
"""

    # Upload files to S3
    s3.put_object(
        Bucket=bucket_name,
        Key=f"{tenant_id}/index.html",
        Body=index_html.encode("utf-8"),
        ContentType="text/html",
    )

    s3.put_object(
        Bucket=bucket_name,
        Key=f"{tenant_id}/app.js",
        Body=app_js.encode("utf-8"),
        ContentType="application/javascript",
    )

    # Update DynamoDB with keyspace provisioned status
    table.update_item(
        Key={"tenant_id": tenant_id},
        UpdateExpression="SET #status = :status, keyspace_provisioned_at = :timestamp, file_count = :count",
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={
            ":status": "KEYSPACE_PROVISIONED",
            ":timestamp": datetime.utcnow().isoformat(),
            ":count": 2,
        },
    )

    return {"tenant_id": tenant_id, "keyspace_provisioned": True, "file_count": 2}
