"""Pre-invoke for find-missing-step-functions-state-machine.

Reproduces the drift the instruction describes -- a Step Functions state machine
CloudFormation still believes it manages, but which no longer exists -- on every
trial, so the DeleteStateMachine evidence the agent (and the reference solution's
CloudTrail lookup) relies on is always fresh.

This replaces the scenario-level setup script that deleted the state machine once
at deploy time. That made the missing-resource state a deploy-time artifact:
repeated trials kept the resource missing but eventually pushed the deletion
event out of the recent CloudTrail window, leaving no discoverable evidence.
Deleting per-trial (with post_invoke recreating the state machine afterwards)
keeps the CloudTrail event recent for every trial.

What it does, idempotently:
  1. Ensure the state machine exists (recreate it from the CloudFormation stack
     if a prior trial's post_invoke never ran -- e.g. a cancelled trial).
  2. Capture its live configuration to a baseline file post_invoke restores from.
  3. Delete it and wait until describe-state-machine reports it gone, so the
     agent sees the exact StateMachineDoesNotExist drift and CloudTrail records a
     fresh DeleteStateMachine event.

Deleting and recreating with the same name yields the same ARN, so the stack's
stored physical id, the verifier placeholders, and the reference solution all
keep resolving to one identity across trials.

Runs with management credentials (like all lifecycle hooks); the agent itself
stays read-only. The task is graded by the LLM judge on the agent's written
diagnosis, so placeholder.json is intentionally empty.

Env vars (from ``[pre_invoke.env]`` in task.toml):
    STATE_MACHINE_ARN   ARN of the state machine to delete (region is read from it).
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

RESULT_FILE = "/logs/pre_invoke/placeholder.json"
# Handoff to post_invoke: the live config captured before deletion, so the
# state machine is restored byte-for-byte (definition, role, logging).
BASELINE_FILE = "/logs/pre_invoke/sm_baseline.json"

# The CloudFormation stack that owns the state machine. Used only to recreate the
# machine when a prior trial left it missing; the drift itself is per-trial state.
STACK_NAME = "api-and-observability-stepfunctions-9bww99xri-us-east-1"

DELETE_TIMEOUT_SEC = 180
ACTIVE_TIMEOUT_SEC = 120
POLL_INTERVAL_SEC = 3


def _region_from_arn(arn: str) -> str:
    # arn:aws:states:<region>:<account>:stateMachine:<name>
    return arn.split(":")[3]


def _describe(sfn, arn: str) -> dict | None:
    """Return the state machine's description, or None when it does not exist."""
    try:
        return sfn.describe_state_machine(stateMachineArn=arn)
    except sfn.exceptions.StateMachineDoesNotExist:
        return None


def _cfn_baseline(region: str) -> dict:
    """Derive a recreate baseline from the CloudFormation stack.

    Fallback for when the live machine is already gone (a prior post_invoke never
    ran) and we still need to recreate it before deleting. The stack's definition
    is a literal ASL string and its execution role persists across the delete, so
    both are recoverable without the live resource. Logging is omitted: the
    recreated machine is deleted again immediately, so its logging config never
    matters to the agent.
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


def _create(sfn, name: str, baseline: dict) -> None:
    """Create the state machine from a baseline, tolerating an in-flight delete.

    Logging/tracing config is intentionally not restored: the recreated machine
    exists only to be deleted again on the next trial and is never executed or
    inspected, so a minimal definition+role machine is enough, and skipping the
    log destination avoids depending on CloudWatch Logs vended-log permissions.
    """
    deadline = time.monotonic() + DELETE_TIMEOUT_SEC
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


def _wait_active(sfn, arn: str) -> None:
    deadline = time.monotonic() + ACTIVE_TIMEOUT_SEC
    while time.monotonic() < deadline:
        desc = _describe(sfn, arn)
        if desc and desc["status"] == "ACTIVE":
            return
        time.sleep(POLL_INTERVAL_SEC)
    raise TimeoutError(f"state machine {arn} did not become ACTIVE in time")


def _delete_and_wait(sfn, arn: str) -> None:
    sfn.delete_state_machine(stateMachineArn=arn)
    deadline = time.monotonic() + DELETE_TIMEOUT_SEC
    while time.monotonic() < deadline:
        if _describe(sfn, arn) is None:
            return
        time.sleep(POLL_INTERVAL_SEC)
    raise TimeoutError(f"state machine {arn} still present after delete")


def run() -> dict[str, str]:
    arn = os.environ["STATE_MACHINE_ARN"]
    name = os.environ["STATE_MACHINE_NAME"]
    region = _region_from_arn(arn)

    sfn = boto3.client("stepfunctions", region_name=region)

    desc = _describe(sfn, arn)
    if desc is None:
        # A prior trial's post_invoke never restored it. Recreate from the stack
        # so this trial still produces a fresh deletion, then re-describe.
        logger.info("state machine %s absent; recreating from %s", name, STACK_NAME)
        _create(sfn, name, _cfn_baseline(region))
        _wait_active(sfn, arn)
        desc = _describe(sfn, arn)
        if desc is None:
            raise RuntimeError(f"failed to recreate state machine {arn}")

    baseline = {
        "definition": desc["definition"],
        "roleArn": desc["roleArn"],
        "type": desc.get("type", "STANDARD"),
    }
    os.makedirs(os.path.dirname(BASELINE_FILE), exist_ok=True)
    with open(BASELINE_FILE, "w") as f:
        json.dump(baseline, f)

    _delete_and_wait(sfn, arn)
    logger.info("deleted state machine %s; describe now reports it gone", name)

    # The LLM judge grades the agent's diagnosis; no dynamic placeholders needed.
    return {}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    try:
        placeholders = run()
    except (ClientError, KeyError, RuntimeError, TimeoutError) as e:
        print(f"pre_invoke failed: {e}", file=sys.stderr)
        sys.exit(1)
    os.makedirs(os.path.dirname(RESULT_FILE), exist_ok=True)
    with open(RESULT_FILE, "w") as f:
        json.dump(placeholders, f)
