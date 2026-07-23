"""
Setup script for stack IAM-e71d403fc (api-and-observability).
Creates unmanaged IAM role and Lambda function outside of CloudFormation, then
deploys two CloudFormation stacks that will fail due to resource name collisions
and a nonexistent VPC, leaving them in ROLLBACK_COMPLETE state.
"""

import io
import sys
import json
import os
import time
import zipfile
from typing import Optional

import boto3
from botocore.config import Config

config = Config(connect_timeout=5, read_timeout=60)

REGION = "us-east-1"
CDK_STACK = "api-and-observability-IAM-e71d403fc-us-east-1"
ROLE_NAME = "TigrisNileAPIGatewayAccessRole"
FUNCTION_NAME = "tigris-api-function-e71d403fc"


def _ensure_role(iam) -> None:
    try:
        iam.get_role(RoleName=ROLE_NAME)
        print(f"Role {ROLE_NAME} already exists")
        return
    except iam.exceptions.NoSuchEntityException:
        pass

    iam.create_role(
        RoleName=ROLE_NAME,
        AssumeRolePolicyDocument=json.dumps(
            {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Principal": {"Service": "apigateway.amazonaws.com"},
                        "Action": "sts:AssumeRole",
                    }
                ],
            }
        ),
        Description="IAM role for API Gateway access",
    )
    iam.put_role_policy(
        RoleName=ROLE_NAME,
        PolicyName="TigrisApiAccessPolicy",
        PolicyDocument=json.dumps(
            {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Action": [
                            "logs:CreateLogGroup",
                            "logs:CreateLogStream",
                            "logs:PutLogEvents",
                        ],
                        "Resource": "*",
                    }
                ],
            }
        ),
    )
    print(f"Created role {ROLE_NAME}")


def _ensure_lambda(lam, iam) -> None:
    try:
        lam.get_function(FunctionName=FUNCTION_NAME)
        print(f"Function {FUNCTION_NAME} already exists")
        return
    except lam.exceptions.ResourceNotFoundException:
        pass

    exec_role_name = f"{FUNCTION_NAME}-exec-role"
    try:
        role_arn = iam.get_role(RoleName=exec_role_name)["Role"]["Arn"]
    except iam.exceptions.NoSuchEntityException:
        role_arn = iam.create_role(
            RoleName=exec_role_name,
            AssumeRolePolicyDocument=json.dumps(
                {
                    "Version": "2012-10-17",
                    "Statement": [
                        {
                            "Effect": "Allow",
                            "Principal": {"Service": "lambda.amazonaws.com"},
                            "Action": "sts:AssumeRole",
                        }
                    ],
                }
            ),
        )["Role"]["Arn"]
        iam.attach_role_policy(
            RoleName=exec_role_name,
            PolicyArn="arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        )
        time.sleep(10)  # wait for role propagation

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            "index.py", 'def handler(event, context): return {"statusCode": 200}'
        )
    buf.seek(0)

    lam.create_function(
        FunctionName=FUNCTION_NAME,
        Runtime="python3.11",
        Role=role_arn,
        Handler="index.handler",
        Code={"ZipFile": buf.read()},
        Timeout=30,
        MemorySize=256,
    )
    print(f"Created function {FUNCTION_NAME}")


def _deploy_failing_stack(cfn, stack_name: str, template_path: str) -> None:
    """Deploy a stack expected to reach ROLLBACK_COMPLETE. Idempotent."""
    try:
        status = cfn.describe_stacks(StackName=stack_name)["Stacks"][0]["StackStatus"]
        print(f"{stack_name}: already {status}")
        if status == "ROLLBACK_COMPLETE":
            return
        if status in ("CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"):
            cfn.delete_stack(StackName=stack_name)
            cfn.get_waiter("stack_delete_complete").wait(
                StackName=stack_name, WaiterConfig={"Delay": 10, "MaxAttempts": 60}
            )
            print(f"Deleted {stack_name}")
    except cfn.exceptions.ClientError as e:
        if "does not exist" not in str(e):
            raise

    with open(template_path) as f:
        template_body = f.read()

    print(f"Creating {stack_name}...")
    cfn.create_stack(
        StackName=stack_name,
        TemplateBody=template_body,
        Capabilities=["CAPABILITY_NAMED_IAM"],
        OnFailure="ROLLBACK",
    )

    for _ in range(60):
        status = cfn.describe_stacks(StackName=stack_name)["Stacks"][0]["StackStatus"]
        if status == "ROLLBACK_COMPLETE":
            print(f"{stack_name}: ROLLBACK_COMPLETE")
            return
        if "IN_PROGRESS" not in status:
            raise RuntimeError(f"{stack_name}: unexpected status {status}")
        time.sleep(10)

    raise RuntimeError(f"{stack_name}: timed out waiting for ROLLBACK_COMPLETE")


def run(session: Optional[boto3.Session] = None, region: str = REGION, **parameters):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY")

    cfn = session.client("cloudformation", config=config, region_name=region)
    iam = session.client("iam", config=config)
    lam = session.client("lambda", config=config, region_name=region)

    outputs = {
        o["OutputKey"]: o["OutputValue"]
        for o in cfn.describe_stacks(StackName=CDK_STACK)["Stacks"][0]["Outputs"]
    }
    service_stack = outputs["FailedStackName"]
    worker_stack = outputs["FailedWorkerStackName"]

    print("Creating unmanaged resources...")
    _ensure_role(iam)
    _ensure_lambda(lam, iam)

    assets_dir = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "assets"
    )

    print("Deploying service stack (will fail on IAM role collision)...")
    _deploy_failing_stack(
        cfn, service_stack, os.path.join(assets_dir, "tigris-service-template.json")
    )

    print("Deploying worker stack (will fail on nonexistent VPC)...")
    _deploy_failing_stack(
        cfn, worker_stack, os.path.join(assets_dir, "tigris-worker-template.json")
    )

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
