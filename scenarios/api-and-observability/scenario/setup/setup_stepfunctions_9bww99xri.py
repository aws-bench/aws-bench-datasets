"""
Setup script for stack stepfunctions-9bww99xri (api-and-observability).
Deletes the Step Functions state machine after deployment to simulate a drift
condition where CloudFormation believes it manages a resource that was manually
deleted outside of CloudFormation.
"""

from typing import Optional

import boto3
import sys
from botocore.config import Config

config = Config(connect_timeout=5, read_timeout=60)

REGION = "us-east-1"
STACK_NAME = "api-and-observability-stepfunctions-9bww99xri-us-east-1"


def run(session: Optional[boto3.Session] = None, region: str = REGION, **parameters):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY")

    cfn = session.client("cloudformation", config=config, region_name=region)
    outputs = {
        o["OutputKey"]: o["OutputValue"]
        for o in cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]["Outputs"]
    }

    state_machine_arn = outputs["StateMachineArn"]
    state_machine_name = outputs["StateMachineName"]

    sfn = session.client("stepfunctions", config=config, region_name=region)

    try:
        sfn.describe_state_machine(stateMachineArn=state_machine_arn)
    except sfn.exceptions.StateMachineDoesNotExist:
        print(f"State machine already deleted: {state_machine_name}")
        return {"success": True, "output_values": None}

    print(f"Deleting state machine to simulate drift: {state_machine_name}")
    sfn.delete_state_machine(stateMachineArn=state_machine_arn)
    print(f"State machine deletion initiated: {state_machine_name}")

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
