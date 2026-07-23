"""
Setup script for stack lambda-mw9wjm2q7 (troubleshooting-multiservice).
Starts Step Functions executions to generate Lambda invocation logs.
"""

import boto3
import sys
import time
from botocore.config import Config

config = Config(connect_timeout=5, read_timeout=60)
STACK_NAME = "troubleshooting-multiservice-lambda-mw9wjm2q7-ap-southeast-2"
REGION = "ap-southeast-2"


def run(session: boto3.Session = None, region: str = REGION, **parameters):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY", region_name=region)

    cfn = session.client("cloudformation", config=config, region_name=region)
    outputs = {
        o["OutputKey"]: o["OutputValue"]
        for o in cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]["Outputs"]
    }
    state_machine_arn = outputs["StateMachineArn"]

    sfn = session.client("stepfunctions", config=config, region_name=region)

    execution_arns = []
    for i in range(5):
        name = f"execution-{i}"
        # Idempotent: skip if execution already exists
        try:
            response = sfn.start_execution(
                stateMachineArn=state_machine_arn,
                name=name,
                input='{"executionType": "scheduled"}',
            )
            execution_arns.append(response["executionArn"])
        except sfn.exceptions.ExecutionAlreadyExists:
            arn = f"{state_machine_arn.replace(':stateMachine:', ':execution:')}:{name}"
            execution_arns.append(arn)

    for arn in execution_arns:
        for _ in range(10):
            status = sfn.describe_execution(executionArn=arn)["status"]
            if status != "RUNNING":
                break
            time.sleep(2)

    return {"execution_arns": execution_arns}


if __name__ == "__main__":
    try:
        result = run()
        print(result)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
