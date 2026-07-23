"""Setup script for stack cloudformation-t9dx4pgqw (troubleshooting-multiservice).
Puts the stack into UPDATE_FAILED state by triggering a CloudFormation update
(DisableRollback=True) that points Lambda aliases to non-existent versions.
Idempotent — skips if the stack is already in UPDATE_FAILED.
"""

import boto3
import json
import sys
from botocore.exceptions import ClientError, WaiterError

REGION = "us-east-1"
STACK_NAME = "troubleshooting-multiservice-cloudformation-t9dx4pgqw-us-east-1"


def get_template(cfn):
    raw = cfn.get_template(StackName=STACK_NAME, TemplateStage="Original")[
        "TemplateBody"
    ]
    return raw if isinstance(raw, dict) else json.loads(raw)


def update_and_wait(cfn, template, disable_rollback=False):
    params = cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0].get(
        "Parameters", []
    )
    try:
        cfn.update_stack(
            StackName=STACK_NAME,
            TemplateBody=json.dumps(template),
            Parameters=params,
            Capabilities=["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"],
            DisableRollback=disable_rollback,
        )
    except ClientError as e:
        if "No updates are to be performed" in str(e):
            return
        raise
    # The update is engineered to fail, so the waiter raising WaiterError on a
    # terminal failure state is the expected outcome. The post-waiter status
    # check below distinguishes that from a real timeout.
    try:
        cfn.get_waiter("stack_update_complete").wait(
            StackName=STACK_NAME,
            WaiterConfig={"Delay": 10, "MaxAttempts": 60},
        )
    except WaiterError:
        pass


def apply_misconfiguration(session, region):
    cfn = session.client("cloudformation", region_name=region)

    status = cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]["StackStatus"]
    if status == "UPDATE_FAILED":
        print("Stack already in UPDATE_FAILED, skipping.")
        return

    if status not in ("CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"):
        raise RuntimeError(f"Unexpected stack status: {status}")

    template = get_template(cfn)
    modified = False
    for v in template.get("Resources", {}).values():
        if v.get("Type") != "AWS::Lambda::Alias":
            continue
        ref = v["Properties"].get("FunctionName", {}).get("Ref", "")
        v["Properties"]["FunctionVersion"] = (
            "593" if "SimpleEmailService" in ref else "268"
        )
        modified = True

    if not modified:
        raise RuntimeError("No Lambda aliases found in template")

    print(
        "Triggering stack update with invalid alias versions (DisableRollback=True)..."
    )
    update_and_wait(cfn, template, disable_rollback=True)

    final_status = cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]["StackStatus"]
    print(f"Stack is now in: {final_status}")
    if final_status != "UPDATE_FAILED":
        # WaiterError swallowed above could mask either a timeout (still
        # UPDATE_IN_PROGRESS) or rollback into an unexpected state — surface it.
        raise RuntimeError(
            f"Expected stack to reach UPDATE_FAILED but got {final_status}"
        )
    print("Done — stack is in expected UPDATE_FAILED state.")


def run(session=None, region=REGION, **parameters):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY", region_name=region)
    cfn = session.client("cloudformation", region_name=region)
    stacks = cfn.describe_stacks(StackName=STACK_NAME)["Stacks"]
    outputs = {o["OutputKey"]: o["OutputValue"] for o in stacks[0].get("Outputs", [])}
    print(f"Stack: {STACK_NAME}")
    print(f"SimpleEmailServiceLambda:      {outputs['SimpleEmailServiceLambdaName']}")
    print(f"GetDetectorOutcomeLambda: {outputs['GetDetectorOutcomeLambdaName']}")
    apply_misconfiguration(session, region)


if __name__ == "__main__":
    try:
        run()
    except Exception as e:
        print(f"Setup failed: {e}", file=sys.stderr)
        sys.exit(1)
