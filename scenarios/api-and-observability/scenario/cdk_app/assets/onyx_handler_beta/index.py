import json
import os
import logging

# Configure logging
log_level = int(os.environ.get("LOGLEVEL", "20"))
logger = logging.getLogger()
logger.setLevel(log_level)


def handler(event, context):
    """
    Onyx Lambda handler for beta environment.
    """
    logger.info(
        f"Beta handler received event with {len(event.get('Records', []))} records"
    )

    processed_count = 0
    skipped_count = 0

    for record in event.get("Records", []):
        event_name = record.get("eventName")
        dynamodb_record = record.get("dynamodb", {})
        new_image = dynamodb_record.get("NewImage", {})

        # Correctly check new state regardless of event type
        new_state = new_image.get("state", {}).get("S", "")

        if new_state == "IN_PROGRESS":
            # For MODIFY events, also check old state
            if event_name == "MODIFY":
                old_image = dynamodb_record.get("OldImage", {})
                old_state = old_image.get("state", {}).get("S", "")
                if old_state == "IN_PROGRESS":
                    logger.debug("Skipping - already in IN_PROGRESS")
                    skipped_count += 1
                    continue

            request_id = new_image.get("id", {}).get("S", "unknown")
            logger.info(
                f"Processing request {request_id} in IN_PROGRESS state (event: {event_name})"
            )
            processed_count += 1
        else:
            skipped_count += 1

    logger.info(
        f"Beta handler processed {processed_count} records, skipped {skipped_count} records"
    )

    return {
        "statusCode": 200,
        "body": json.dumps({"processed": processed_count, "skipped": skipped_count}),
    }
