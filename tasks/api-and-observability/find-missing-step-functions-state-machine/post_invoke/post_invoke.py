"""Post-invoke for find-missing-step-functions-state-machine.

Recreates the state machine this trial's pre_invoke deleted, restoring the
deployed baseline so the next trial's pre_invoke has a machine to delete (and to
keep the account tidy for reuse). Recreating with the same name yields the same
ARN the stack, verifier, and solution already reference.

It runs after the verifier has scored, so restoring the resource the agent
diagnosed as missing is safe.

Idempotent and safe to retry: if the machine already exists (nothing was deleted,
or a retry already recreated it) there is nothing to do. It prefers the exact
config pre_invoke captured; if that handoff is unavailable it rebuilds a
functional machine from the CloudFormation stack.

A skipped post_invoke (a crashed or cancelled trial) leaves the machine deleted;
the next trial's pre_invoke self-heals by recreating it from the stack.

Env vars (from ``[post_invoke.env]`` in task.toml):
    STATE_MACHINE_ARN   ARN of the state machine (region is read from it).
    STATE_MACHINE_NAME  Name used to recreate it with the same ARN.
"""

import json
import logging
import os
import sys
import time

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

# Written by pre_invoke: the live config captured before deletion.
BASELINE_FILE = "/logs/pre_invoke/sm_baseline.json"

# The CloudFormation stack that owns the state machine, used to rebuild a
# functional machine when the pre_invoke handoff is unavailable.
STACK_NAME = "api-and-observability-stepfunctions-9bww99xri-us-east-1"

CREATE_TIMEOUT_SEC = 180
POLL_INTERVAL_SEC = 3


def _region_from_arn(arn: str) -> str:
    # arn:aws:states:<region>:<account>:stateMachine:<name>
    return arn.split(":")[3]


def _exists(sfn, arn: str) -> bool:
    try:
        sfn.describe_state_machine(stateMachineArn=arn)
        return True
    except sfn.exceptions.StateMachineDoesNotExist:
        return False


def _cfn_baseline(region: str) -> dict:
    """Rebuild a recreate baseline from the CloudFormation stack.

    Used only when the pre_invoke handoff file is missing. The stack's definition
    is a literal ASL string and its execution role persists across the delete.
    Logging is omitted; a restored-baseline machine that lacks the log
    destination is inert for this task and is deleted again by the next trial.
    """
    cfn = boto3.client("cloudformation", region_name=region)

    template = cfn.get_template(StackName=STACK_NAME)["TemplateBody"]
    if isinstance(template, str):
        template = json.loads(template)

    definition = None
    sm_type = "STANDARD"
    for resource in template.get("Resources", {}).values():
        if resource.get("Type") == "AWS::StepFunctions::StateMachine":
            props = resource.get("Properties", {})
            definition = props.get("DefinitionString")
            sm_type = props.get("StateMachineType", "STANDARD")
            break
    if not isinstance(definition, str):
        raise RuntimeError(
            f"could not read a literal DefinitionString from {STACK_NAME} template"
        )

    role_name = None
    for res in cfn.describe_stack_resources(StackName=STACK_NAME)["StackResources"]:
        if res["ResourceType"] == "AWS::IAM::Role" and res[
            "LogicalResourceId"
        ].startswith("StateMachineRole"):
            role_name = res["PhysicalResourceId"]
            break
    if not role_name:
        raise RuntimeError(f"no StateMachineRole IAM role found in {STACK_NAME}")

    account = boto3.client("sts").get_caller_identity()["Account"]
    return {
        "definition": definition,
        "roleArn": f"arn:aws:iam::{account}:role/{role_name}",
        "type": sm_type,
    }


def _load_baseline(region: str) -> dict:
    try:
        with open(BASELINE_FILE) as f:
            baseline = json.load(f)
        if baseline.get("definition") and baseline.get("roleArn"):
            return baseline
        logger.info("baseline file incomplete; deriving from %s", STACK_NAME)
    except (FileNotFoundError, json.JSONDecodeError):
        logger.info("no pre_invoke baseline handoff; deriving from %s", STACK_NAME)
    return _cfn_baseline(region)


def _create(sfn, name: str, baseline: dict) -> None:
    """Create the state machine from a baseline, tolerating an in-flight delete.

    Logging/tracing config is intentionally not restored: the recreated machine
    exists only to be deleted again on the next trial and is never executed or
    inspected, so a minimal definition+role machine is enough, and skipping the
    log destination avoids depending on CloudWatch Logs vended-log permissions.
    """
    deadline = time.monotonic() + CREATE_TIMEOUT_SEC
    while True:
        try:
            sfn.create_state_machine(
                name=name,
                definition=baseline["definition"],
                roleArn=baseline["roleArn"],
                type=baseline.get("type", "STANDARD"),
            )
            return
        except sfn.exceptions.StateMachineAlreadyExists:
            return
        except sfn.exceptions.StateMachineDeleting:
            if time.monotonic() >= deadline:
                raise
            time.sleep(POLL_INTERVAL_SEC)


def run() -> None:
    arn = os.environ["STATE_MACHINE_ARN"]
    name = os.environ["STATE_MACHINE_NAME"]
    region = _region_from_arn(arn)

    sfn = boto3.client("stepfunctions", region_name=region)

    if _exists(sfn, arn):
        logger.info("state machine %s already present; nothing to restore", name)
        return

    _create(sfn, name, _load_baseline(region))
    logger.info("recreated state machine %s", name)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    try:
        run()
    except (ClientError, KeyError, RuntimeError) as e:
        print(f"post_invoke failed: {e}", file=sys.stderr)
        sys.exit(1)
