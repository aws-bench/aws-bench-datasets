import json
import os
import logging
import boto3
from decimal import Decimal
import time

# Configure logging
log_level = int(os.environ.get("LOGLEVEL", "20"))
logger = logging.getLogger()
logger.setLevel(log_level)

dynamodb = boto3.client("dynamodb")


def handler(event, context):
    """
    Buffer Timeout Lambda - transitions requests from BUFFER to IN_PROGRESS after timeout.
    """
    logger.info("Buffer timeout handler invoked")

    regression_table = os.environ.get("REGRESSION_REQUESTS_TABLE")
    basalt_table = os.environ.get("BASALT_REQUESTS_TABLE")

    current_time = Decimal(str(time.time()))
    updated_count = 0

    # Scan for expired buffer items
    for table_name in [regression_table, basalt_table]:
        try:
            response = dynamodb.scan(
                TableName=table_name,
                FilterExpression="#state = :buffer_state AND buffer_expires_at < :current_time",
                ExpressionAttributeNames={"#state": "state"},
                ExpressionAttributeValues={
                    ":buffer_state": {"S": "BUFFER"},
                    ":current_time": {"N": str(current_time)},
                },
            )

            for item in response.get("Items", []):
                request_id = item["id"]["S"]
                logger.info(f"Transitioning {request_id} from BUFFER to IN_PROGRESS")

                # Update to IN_PROGRESS
                dynamodb.update_item(
                    TableName=table_name,
                    Key={"id": {"S": request_id}},
                    UpdateExpression="SET #state = :new_state, updated_at = :updated_at",
                    ExpressionAttributeNames={"#state": "state"},
                    ExpressionAttributeValues={
                        ":new_state": {"S": "IN_PROGRESS"},
                        ":updated_at": {"N": str(current_time)},
                    },
                )
                updated_count += 1
        except Exception as e:
            logger.error(f"Error processing table {table_name}: {e}")

    logger.info(f"Updated {updated_count} requests from BUFFER to IN_PROGRESS")

    return {"statusCode": 200, "body": json.dumps({"updated": updated_count})}
