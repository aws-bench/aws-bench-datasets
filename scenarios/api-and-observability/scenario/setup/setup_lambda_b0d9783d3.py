"""
Setup script for stack Lambda-b0d9783d3 (api-and-observability).
Seeds DynamoDB tables with test data demonstrating both working and broken
request patterns, then waits for Lambda to process the stream events and
generate CloudWatch Logs.
"""

import time
import sys
from decimal import Decimal
from typing import Optional

import boto3
from botocore.config import Config

config = Config(connect_timeout=5, read_timeout=60)

REGION = "us-east-1"
STACK_NAME = "api-and-observability-Lambda-b0d9783d3-us-east-1"


def run(session: Optional[boto3.Session] = None, region: str = REGION, **parameters):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY")

    cfn = session.client("cloudformation", config=config, region_name=region)
    dynamodb = session.client("dynamodb", config=config, region_name=region)

    outputs = {
        o["OutputKey"]: o["OutputValue"]
        for o in cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]["Outputs"]
    }

    regression_table = outputs["RegressionRequestsTableName"]
    basalt_table = outputs["BasaltRequestsTableName"]
    regression_beta_table = outputs["RegressionRequestsBetaTableName"]
    onyx_function = outputs["OnyxFunctionName"]

    print(f"Regression table: {regression_table}")
    print(f"Basalt table: {basalt_table}")
    print(f"Onyx function: {onyx_function}")

    ts = Decimal(str(time.time()))

    # BAT request: BUFFER -> IN_PROGRESS (two-step pattern)
    bat_id = "bat-req-001-working"
    print(f"Creating BAT request {bat_id} in BUFFER state...")
    dynamodb.put_item(
        TableName=basalt_table,
        Item={
            "id": {"S": bat_id},
            "team_id": {"S": "team-benchmark-001"},
            "device_type": {"S": "Draco"},
            "build_type": {"S": "Corvus"},
            "build_number": {"S": "P0-Corvus-1772041353"},
            "priority": {"S": "P0"},
            "devices": {"L": [{"S": "Orion"}]},
            "alexa_version": {"S": "Vela"},
            "release_branch": {"S": "B41"},
            "state": {"S": "BUFFER"},
            "created_by": {"S": "Flint"},
            "created_at": {"N": str(ts)},
            "updated_at": {"N": str(ts)},
            "description": {"S": "BAT request using BUFFER->IN_PROGRESS pattern"},
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
    print(f"Updating BAT request {bat_id} to IN_PROGRESS...")
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
    time.sleep(3)

    # Regression requests: direct INSERT with IN_PROGRESS
    for i, req_id in enumerate(
        ["d5b17b8a-cee9-4297-a352-885a418df873", "reg-req-002-skipped"]
    ):
        insert_ts = Decimal(str(time.time()))
        print(f"Creating regression request {req_id} directly in IN_PROGRESS...")
        dynamodb.put_item(
            TableName=regression_table,
            Item={
                "id": {"S": req_id},
                "team_id": {"S": "team-benchmark-001"},
                "device_type": {"S": "Draco"},
                "build_type": {"S": "Corvus" if i == 0 else "Fornax"},
                "build_number": {"S": f"P{i}-Corvus-177204135{i}"},
                "priority": {"S": f"P{i}"},
                "devices": {"L": [{"S": "Orion" if i == 0 else "Lyra"}]},
                "alexa_version": {"S": "Vela"},
                "release_branch": {"S": f"B4{1 + i}"},
                "state": {"S": "IN_PROGRESS"},
                "created_by": {"S": "Flint"},
                "created_at": {"N": str(insert_ts)},
                "updated_at": {"N": str(insert_ts)},
                "description": {"S": "Regression request created from bulk request"},
                "bulk_request_id": {"S": f"bulk-req-{i + 1:03d}"},
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
        time.sleep(3)

    # Beta regression request (for beta Lambda)
    beta_ts = Decimal(str(time.time()))
    dynamodb.put_item(
        TableName=regression_beta_table,
        Item={
            "id": {"S": "beta-reg-req-001"},
            "team_id": {"S": "team-benchmark-001"},
            "device_type": {"S": "Draco"},
            "build_type": {"S": "Corvus"},
            "build_number": {"S": "P0-Corvus-1772041500"},
            "priority": {"S": "P0"},
            "devices": {"L": [{"S": "Orion"}]},
            "alexa_version": {"S": "Vela"},
            "release_branch": {"S": "B41"},
            "state": {"S": "IN_PROGRESS"},
            "created_by": {"S": "Flint"},
            "created_at": {"N": str(beta_ts)},
            "updated_at": {"N": str(beta_ts)},
            "description": {"S": "Beta regression request"},
            "bulk_request_id": {"S": "bulk-req-beta-001"},
        },
    )
    time.sleep(2)

    # COMPLETED and FAILED requests (noise)
    for i in range(3):
        dynamodb.put_item(
            TableName=basalt_table,
            Item={
                "id": {"S": f"completed-req-{i:03d}"},
                "team_id": {"S": "team-benchmark-001"},
                "device_type": {"S": "Draco"},
                "build_type": {"S": "Corvus"},
                "build_number": {"S": f"P0-Corvus-177204{1600 + i}"},
                "priority": {"S": "P0"},
                "devices": {"L": [{"S": "Orion"}]},
                "alexa_version": {"S": "Vela"},
                "release_branch": {"S": "B41"},
                "state": {"S": "COMPLETED"},
                "created_by": {"S": "Flint"},
                "created_at": {"N": str(Decimal(str(time.time())))},
                "updated_at": {"N": str(Decimal(str(time.time())))},
                "description": {"S": f"Completed request {i}"},
            },
        )
        time.sleep(1)

    dynamodb.put_item(
        TableName=regression_table,
        Item={
            "id": {"S": "failed-req-001"},
            "team_id": {"S": "team-benchmark-001"},
            "device_type": {"S": "Draco"},
            "build_type": {"S": "Corvus"},
            "build_number": {"S": "P0-Corvus-1772041700"},
            "priority": {"S": "P0"},
            "devices": {"L": [{"S": "Orion"}]},
            "alexa_version": {"S": "Vela"},
            "release_branch": {"S": "B41"},
            "state": {"S": "FAILED"},
            "created_by": {"S": "Flint"},
            "created_at": {"N": str(Decimal(str(time.time())))},
            "updated_at": {"N": str(Decimal(str(time.time())))},
            "description": {"S": "Failed request"},
            "error_message": {"S": "Test execution failed"},
        },
    )

    time.sleep(5)
    print("Setup complete")

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
