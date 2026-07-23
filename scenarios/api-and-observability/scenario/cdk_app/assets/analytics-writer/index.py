"""
Analytics writer Lambda function.
"""

import json
import boto3
import os
from datetime import datetime

s3_client = boto3.client("s3", region_name=os.environ.get("REGION", "us-east-1"))


def handler(event, context):
    reports_bucket = os.environ.get("REPORTS_BUCKET")

    print(f"Analytics writer invoked at {datetime.utcnow().isoformat()}")
    print(f"Writing reports to bucket: {reports_bucket}")

    return {
        "statusCode": 200,
        "body": json.dumps(
            {
                "message": "Report written successfully",
                "timestamp": datetime.utcnow().isoformat(),
            }
        ),
    }
