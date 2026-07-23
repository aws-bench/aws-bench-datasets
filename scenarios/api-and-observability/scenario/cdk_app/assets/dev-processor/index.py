"""
Dev processor Lambda function.
"""

import json
import boto3
import os
from datetime import datetime

s3_client = boto3.client("s3", region_name=os.environ.get("REGION", "us-east-1"))


def handler(event, context):
    analytics_bucket = os.environ.get("ANALYTICS_BUCKET")
    environment = os.environ.get("ENVIRONMENT", "dev")

    print(f"Dev processor invoked at {datetime.utcnow().isoformat()}")
    print(f"Environment: {environment}")
    print(f"Analytics bucket: {analytics_bucket}")

    return {
        "statusCode": 200,
        "body": json.dumps(
            {
                "message": "Dev processing completed successfully",
                "environment": environment,
                "timestamp": datetime.utcnow().isoformat(),
            }
        ),
    }
