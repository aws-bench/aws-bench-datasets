import json
import os
import boto3
import time
from datetime import datetime

s3_client = boto3.client("s3", region_name=os.environ["ANALYTICS_S3_REGION"])


def handler(event, context):
    """
    Processes billing reconciliation events and writes analytics to S3.
    """
    analytics_bucket = os.environ["ANALYTICS_S3_BUCKET"]
    output_queue_url = os.environ["OUTPUT_QUEUE_URL"]

    sqs_client = boto3.client("sqs")

    for record in event["Records"]:
        try:
            body = json.loads(record["body"])
            request_id = body.get("request_id", "unknown")

            print(f"Processing reconciliation request: {request_id}")

            # Simulate reconciliation processing
            analytics_data = {
                "request_id": request_id,
                "timestamp": datetime.utcnow().isoformat(),
                "status": "processed",
                "metrics": {
                    "items_reconciled": 42,
                    "discrepancies_found": 3,
                    "processing_time_ms": 1250,
                },
            }

            analytics_key = (
                f"analytics/{datetime.utcnow().strftime('%Y/%m/%d')}/{request_id}.json"
            )

            print(f"Attempting to store analytics for request: {request_id}")

            try:
                s3_client.put_object(
                    Bucket=analytics_bucket,
                    Key=analytics_key,
                    Body=json.dumps(analytics_data),
                    ContentType="application/json",
                )
                print(f"Successfully stored analytics for request: {request_id}")
            except Exception as s3_error:
                print(
                    f"ERROR: Failed to store analytics for request: {request_id} - continuing workflow"
                )
                print(f"ERROR: {str(s3_error)}")
                # Continue processing even if analytics write fails

            response_message = {
                "request_id": request_id,
                "status": "completed",
                "timestamp": datetime.utcnow().isoformat(),
            }

            sqs_client.send_message(
                QueueUrl=output_queue_url, MessageBody=json.dumps(response_message)
            )

            print(f"Completed processing for request: {request_id}")

        except Exception as e:
            print(f"ERROR: Failed to process record: {str(e)}")
            raise

    return {"statusCode": 200, "body": json.dumps("Processing complete")}
