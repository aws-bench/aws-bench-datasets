"""
Setup script for stack Lambda-37634fcce (api-and-observability).
Sends test messages to SQS to trigger Lambda and generate logs.
"""

import json
import sys
import time
from typing import Optional

import boto3


REGION = "us-west-2"
STACK_NAME = "api-and-observability-Lambda-37634fcce-us-west-2"

TEST_REQUESTS = [
    {
        "request_id": "7f71835b-b1bb-449a-829c-6c3ae2f780a1_31459400",
        "customer_id": "CUST-12345",
        "billing_period": "2024-01",
        "amount": 15234.56,
    },
    {
        "request_id": "8a82946c-c2cc-55ab-a3ad-7d4bf891b512_31459401",
        "customer_id": "CUST-67890",
        "billing_period": "2024-01",
        "amount": 8765.43,
    },
    {
        "request_id": "9b93a57d-d3dd-66bc-b4be-8e5cg9a2c623_31459402",
        "customer_id": "CUST-11111",
        "billing_period": "2024-01",
        "amount": 23456.78,
    },
]


def run(session: Optional[boto3.Session] = None, region: str = REGION, **parameters):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY")

    cfn = session.client("cloudformation", region_name=region)
    outputs = {
        o["OutputKey"]: o["OutputValue"]
        for o in cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]["Outputs"]
    }

    input_queue_url = outputs["InputQueueUrl"]
    log_group_name = outputs.get("LogGroupName")

    sqs = session.client("sqs", region_name=region)

    # Check if messages already processed (log streams exist)
    if log_group_name:
        logs = session.client("logs", region_name=region)
        try:
            streams = logs.describe_log_streams(
                logGroupName=log_group_name,
                orderBy="LastEventTime",
                descending=True,
                limit=1,
            )
            if streams["logStreams"]:
                print("Log streams already exist, skipping message send")
                return {"success": True, "output_values": None}
        except Exception:
            pass

    print(f"Sending {len(TEST_REQUESTS)} test reconciliation requests...")
    for request in TEST_REQUESTS:
        sqs.send_message(QueueUrl=input_queue_url, MessageBody=json.dumps(request))
        print(f"Sent request {request['request_id']}")

    print("Waiting 90 seconds for Lambda to process messages...")
    time.sleep(90)

    return {"success": True, "output_values": None}


if __name__ == "__main__":
    try:
        result = run()
        print(result)
        if isinstance(result, dict) and not result.get("success", True):
            sys.exit(1)
    except Exception as e:
        print(f"Setup failed: {e}", file=sys.stderr)
        sys.exit(1)
