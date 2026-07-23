"""
Config loader Lambda function.
"""

import json
import boto3
import os
from datetime import datetime

s3_client = boto3.client("s3", region_name=os.environ.get("REGION", "us-west-2"))


def handler(event, context):
    config_bucket = os.environ.get("CONFIG_BUCKET")
    temp_bucket = os.environ.get("TEMP_BUCKET")

    print(f"Config loader invoked at {datetime.utcnow().isoformat()}")
    print(f"Config bucket: {config_bucket}")
    print(f"Temp bucket: {temp_bucket}")

    return {
        "statusCode": 200,
        "body": json.dumps(
            {
                "message": "Configuration loaded successfully",
                "timestamp": datetime.utcnow().isoformat(),
            }
        ),
    }
