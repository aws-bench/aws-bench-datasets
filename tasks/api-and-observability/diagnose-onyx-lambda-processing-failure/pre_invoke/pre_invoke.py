"""
Pre-invoke script for stack Lambda-b0d9783d3 (api-and-observability)

What this does:
  Creates fresh DynamoDB stream events before each probe to ensure recent
  Lambda logs exist. Seeds both the working BAT pattern (BUFFER->IN_PROGRESS)
  and the bulk regression pattern (direct INSERT with IN_PROGRESS).

Prerequisites:
  - Stack must be deployed and setup script must have been run first
  - AWS credentials must be active for the target account

Stack outputs used:
  RegressionRequestsTableName, BasaltRequestsTableName
    from api-and-observability-Lambda-b0d9783d3-us-east-1
"""

import json
import os
import logging
import sys
import time
from decimal import Decimal
from typing import Any, Dict, Optional

import boto3
from botocore.config import Config

logger = logging.getLogger(__name__)
config = Config(connect_timeout=5, read_timeout=60)


REGION = "us-east-1"
STACK_NAME = "api-and-observability-Lambda-b0d9783d3-us-east-1"


RESULT_FILE = "/logs/pre_invoke/placeholder.json"


def run(
    session: Optional[boto3.Session] = None,
    region: str = REGION,
    **parameters,
):
    if session is None:
        session = boto3.Session(region_name=region)

    cfn = session.client("cloudformation", config=config, region_name=region)
    dynamodb = session.client("dynamodb", config=config, region_name=region)

    outputs = {
        o["OutputKey"]: o["OutputValue"]
        for o in cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]["Outputs"]
    }

    regression_table = outputs["RegressionRequestsTableName"]
    basalt_table = outputs["BasaltRequestsTableName"]

    probe_id = str(int(time.time()))
    ts = Decimal(str(time.time()))

    # BAT request: BUFFER -> IN_PROGRESS
    bat_id = f"bat-req-probe-{probe_id}"
    logger.info(f"Creating BAT request {bat_id} in BUFFER...")
    dynamodb.put_item(
        TableName=basalt_table,
        Item={
            "id": {"S": bat_id},
            "team_id": {"S": "team-benchmark-001"},
            "device_type": {"S": "Draco"},
            "build_type": {"S": "Corvus"},
            "build_number": {"S": f"P0-Corvus-{probe_id}"},
            "priority": {"S": "P0"},
            "devices": {"L": [{"S": "Orion"}]},
            "alexa_version": {"S": "Vela"},
            "release_branch": {"S": "B41"},
            "state": {"S": "BUFFER"},
            "created_by": {"S": "Flint"},
            "created_at": {"N": str(ts)},
            "updated_at": {"N": str(ts)},
            "description": {"S": f"BAT request for probe {probe_id}"},
            "state_history": {
                "L": [
                    {
                        "M": {
                            "state": {"S": "BUFFER"},
                            "timestamp": {"N": str(ts)},
                            "user": {"S": "Flint"},
                            "reason": {"S": "Initial creation"},
                        }
                    }
                ]
            },
            "buffer_expires_at": {"N": str(ts + 300)},
        },
    )
    time.sleep(2)

    update_ts = Decimal(str(time.time()))
    dynamodb.update_item(
        TableName=basalt_table,
        Key={"id": {"S": bat_id}},
        UpdateExpression="SET #state = :new_state, updated_at = :updated_at, state_history = list_append(state_history, :new_history)",
        ExpressionAttributeNames={"#state": "state"},
        ExpressionAttributeValues={
            ":new_state": {"S": "IN_PROGRESS"},
            ":updated_at": {"N": str(update_ts)},
            ":new_history": {
                "L": [
                    {
                        "M": {
                            "state": {"S": "IN_PROGRESS"},
                            "timestamp": {"N": str(update_ts)},
                            "user": {"S": "Flint"},
                            "reason": {"S": "Buffer timeout expired"},
                        }
                    }
                ]
            },
        },
    )
    logger.info(f"BAT request {bat_id} transitioned to IN_PROGRESS")
    time.sleep(2)

    # Regression requests: direct INSERT with IN_PROGRESS
    for suffix in ["", "-alt"]:
        req_id = f"reg-req-probe-{probe_id}{suffix}"
        insert_ts = Decimal(str(time.time()))
        logger.info(f"Creating regression request {req_id} directly in IN_PROGRESS...")
        dynamodb.put_item(
            TableName=regression_table,
            Item={
                "id": {"S": req_id},
                "team_id": {"S": "team-benchmark-001"},
                "device_type": {"S": "Draco"},
                "build_type": {"S": "Corvus" if not suffix else "Fornax"},
                "build_number": {"S": f"P0-Corvus-{probe_id}{suffix}"},
                "priority": {"S": "P0" if not suffix else "P1"},
                "devices": {"L": [{"S": "Orion" if not suffix else "Lyra"}]},
                "alexa_version": {"S": "Vela"},
                "release_branch": {"S": "B41" if not suffix else "B42"},
                "state": {"S": "IN_PROGRESS"},
                "created_by": {"S": "Flint"},
                "created_at": {"N": str(insert_ts)},
                "updated_at": {"N": str(insert_ts)},
                "description": {"S": f"Regression request for probe {probe_id}"},
                "bulk_request_id": {"S": f"bulk-req-probe-{probe_id}{suffix}"},
                "state_history": {
                    "L": [
                        {
                            "M": {
                                "state": {"S": "IN_PROGRESS"},
                                "timestamp": {"N": str(insert_ts)},
                                "user": {"S": "Flint"},
                                "reason": {"S": "Created from bulk request"},
                            }
                        }
                    ]
                },
            },
        )
        time.sleep(2)

    time.sleep(5)
    logger.info(
        f"Pre-invoke complete: probe_id={probe_id}, bat_request_id=bat-req-probe-{probe_id}"
    )

    return


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
