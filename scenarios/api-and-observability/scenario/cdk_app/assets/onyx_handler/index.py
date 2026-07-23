import json
import os
import logging
from datetime import datetime

# Configure logging
log_level = int(os.environ.get("LOGLEVEL", "20"))
logger = logging.getLogger()
logger.setLevel(log_level)


def handler(event, context):
    """
    Onyx Lambda handler that processes DynamoDB Stream events to trigger Quartz tests.

    Filter logic: Only processes records where OldImage exists AND state changed to IN_PROGRESS.
    """
    logger.debug(f"Received event: {json.dumps(event)}")

    processed_count = 0
    skipped_count = 0

    for record in event.get("Records", []):
        event_name = record.get("eventName")
        event_source = record.get("eventSource", "")

        # Handle SQS retry messages differently
        if event_source == "aws:sqs":
            logger.info("Processing retry message from SQS")
            # Process retry logic here
            processed_count += 1
            continue

        # Get DynamoDB record
        dynamodb_record = record.get("dynamodb", {})

        # Check if OldImage exists
        if "OldImage" not in dynamodb_record:
            logger.debug(
                f"Skipping record - no OldImage present (event type: {event_name})"
            )
            skipped_count += 1
            continue

        old_image = dynamodb_record.get("OldImage", {})
        new_image = dynamodb_record.get("NewImage", {})

        # Extract state values
        old_state = old_image.get("state", {}).get("S", "")
        new_state = new_image.get("state", {}).get("S", "")

        # Check if this is a state change TO IN_PROGRESS
        if new_state == "IN_PROGRESS" and old_state != "IN_PROGRESS":
            request_id = new_image.get("id", {}).get("S", "unknown")
            table_name = (
                record.get("eventSourceARN", "").split("/")[-3]
                if "/" in record.get("eventSourceARN", "")
                else "unknown"
            )

            logger.info(
                f"Processing request {request_id} from table {table_name}: state changed from {old_state} to {new_state}"
            )

            # Simulate triggering Quartz test
            logger.info(f"Triggering Quartz test for request {request_id}")
            processed_count += 1
        else:
            logger.debug(
                f"Skipping record - not a state change to IN_PROGRESS (old: {old_state}, new: {new_state})"
            )
            skipped_count += 1

    logger.info(f"Processed {processed_count} records, skipped {skipped_count} records")

    # Publish metric for skipped records (for CloudWatch alarm)
    if skipped_count > 0:
        try:
            import boto3

            cloudwatch = boto3.client("cloudwatch")
            cloudwatch.put_metric_data(
                Namespace="Basalt/Onyx",
                MetricData=[
                    {
                        "MetricName": "SkippedRecords",
                        "Value": skipped_count,
                        "Unit": "Count",
                        "Timestamp": datetime.utcnow(),
                    }
                ],
            )
        except Exception as e:
            logger.warning(f"Failed to publish skipped records metric: {e}")

    return {
        "statusCode": 200,
        "body": json.dumps({"processed": processed_count, "skipped": skipped_count}),
    }
