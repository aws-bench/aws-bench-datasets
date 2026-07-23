"""
Quartz Backfill Lambda Function

This function checks the Quartz backfill DLQ every 5 minutes for failed messages.
In normal operation, the DLQ should be empty, indicating no failures in the
Quartz service integration.
"""

import json
import time
import logging
import os

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def lambda_handler(event, context):
    """
    Lambda handler for Quartz backfill processing

    Args:
        event: Event data containing isPulling and queueName
        context: Lambda context

    Returns:
        dict: Response with statusCode and body
    """
    logger.info(f"lambda_handler -- event: {json.dumps(event)}")

    start_time = int(time.time())

    # Simulate checking the DLQ
    # In this scenario, the DLQ is empty because the issue is not with
    # message delivery but with the Quartz service performance
    time.sleep(5)

    end_time = int(time.time())
    duration = end_time - start_time

    logger.info(f"start: {start_time}, end: {end_time}, duration: {duration}")

    return {
        "statusCode": 200,
        "body": json.dumps(
            {
                "message": "DLQ check completed",
                "messagesProcessed": 0,
                "duration": duration,
            }
        ),
    }
