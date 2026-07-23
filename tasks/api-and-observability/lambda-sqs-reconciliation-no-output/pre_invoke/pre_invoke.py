#!/usr/bin/env python3
"""
Pre-invoke script for stack Lambda-37634fcce (api-and-observability).
Sends a message to SQS to trigger Lambda and generate fresh logs.
"""

import json
import os
import logging
import sys
import time
import uuid
from datetime import datetime
from typing import Any, Dict, Optional

import boto3
from botocore.config import Config

logger = logging.getLogger(__name__)
config = Config(connect_timeout=5, read_timeout=60)

REGION = "us-west-2"
STACK_NAME = "api-and-observability-Lambda-37634fcce-us-west-2"
LOG_WAIT_TIMEOUT = 180


RESULT_FILE = "/logs/pre_invoke/placeholder.json"


def run(
    session: Optional[boto3.Session] = None,
    region: str = REGION,
    **parameters,
):
    if session is None:
        session = boto3.Session(region_name=region)

    cfn = session.client("cloudformation", config=config, region_name=region)

    stack = cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]
    outputs = {o["OutputKey"]: o["OutputValue"] for o in stack.get("Outputs", [])}
    input_queue_url = outputs.get("InputQueueUrl")
    log_group_name = outputs.get("LogGroupName")

    if not input_queue_url:
        logger.error(f"InputQueueUrl output missing from stack {STACK_NAME}")
        raise RuntimeError("pre_invoke failed")

    sqs = session.client("sqs", config=config, region_name=region)
    logs = session.client("logs", config=config, region_name=region)

    request_id = f"{uuid.uuid4()}_{int(time.time())}"
    test_request = {
        "request_id": request_id,
        "customer_id": f"CUST-{uuid.uuid4().hex[:8].upper()}",
        "billing_period": datetime.utcnow().strftime("%Y-%m"),
        "amount": 12345.67,
    }

    logger.info(f"Sending fresh reconciliation request: {request_id}")
    sent_at = int(time.time() * 1000)
    response = sqs.send_message(
        QueueUrl=input_queue_url, MessageBody=json.dumps(test_request)
    )
    logger.info(f"Sent request: MessageId={response['MessageId']}")

    if not log_group_name:
        logger.warning("LogGroupName output missing — falling back to fixed wait")
        time.sleep(LOG_WAIT_TIMEOUT)
        return

    logger.info(
        f"Waiting up to {LOG_WAIT_TIMEOUT}s for Lambda log entry after {request_id}..."
    )
    deadline = time.time() + LOG_WAIT_TIMEOUT
    while time.time() < deadline:
        time.sleep(10)
        streams = logs.describe_log_streams(
            logGroupName=log_group_name,
            orderBy="LastEventTime",
            descending=True,
            limit=5,
        ).get("logStreams", [])
        for stream in streams:
            if stream.get("lastIngestionTime", 0) >= sent_at:
                logger.info(f"Log entry found in stream {stream['logStreamName']}")
                return
        logger.info("No recent log entries yet, waiting...")

    logger.error(f"No Lambda log entries appeared within {LOG_WAIT_TIMEOUT}s")
    raise RuntimeError("pre_invoke failed")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    try:
        run()
    except Exception as e:
        print(f"pre_invoke failed: {e}", file=sys.stderr)
        sys.exit(1)
    os.makedirs(os.path.dirname(RESULT_FILE), exist_ok=True)
    with open(RESULT_FILE, "w") as f:
        json.dump({}, f)
