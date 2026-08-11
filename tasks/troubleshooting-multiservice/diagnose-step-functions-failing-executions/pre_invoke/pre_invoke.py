"""Pre-invoke for diagnose-step-functions-failing-executions.

Starts fresh Step Functions executions before each trial so the agent always
has recent failing executions to diagnose. Every execution fails at
InvokeProcessingLambda because the processing Lambda raises
    RuntimeError("Configuration validation failed: missing required field 'targetBucket'").

This replaces the scenario-level setup script: the failing executions are now
per-trial evidence (started here on every invoke) rather than one-time scenario
state. It always starts REQUIRED_FAILURES fresh executions — it never reuses
failures from a prior trial — so every run provably exercises the currently
deployed Lambda. Pre-invoke asserts that each freshly started execution reaches
FAILED with a cause naming the missing 'targetBucket' field, and fails loudly
otherwise, so a broken Lambda/state-machine surfaces immediately.

Runs with management credentials (like all lifecycle hooks); the agent itself
stays read-only. The task is graded by the LLM judge on the agent's written
diagnosis, so placeholder.json is intentionally empty.
"""

import json
import logging
import os
import sys
import time
import uuid

import boto3
from botocore.config import Config

logger = logging.getLogger(__name__)
config = Config(connect_timeout=5, read_timeout=60)

RESULT_FILE = "/logs/pre_invoke/placeholder.json"

REQUIRED_FAILURES = 5
EXPECTED_CAUSE_SUBSTRING = "targetBucket"
POLL_ATTEMPTS = 30
POLL_INTERVAL = 2


def _region_from_arn(arn: str) -> str:
    # arn:aws:states:<region>:<account>:stateMachine:<name>
    return arn.split(":")[3]


def _wait_for_terminal(sfn, arn):
    for _ in range(POLL_ATTEMPTS):
        desc = sfn.describe_execution(executionArn=arn)
        if desc["status"] != "RUNNING":
            return desc
        time.sleep(POLL_INTERVAL)
    return sfn.describe_execution(executionArn=arn)


def _is_expected_failure(desc):
    if desc.get("status") != "FAILED":
        return False
    cause = desc.get("cause") or ""
    error = desc.get("error") or ""
    return EXPECTED_CAUSE_SUBSTRING in cause or EXPECTED_CAUSE_SUBSTRING in error


def run(session: boto3.Session = None, **parameters) -> dict[str, str]:
    state_machine_arn = os.environ["STATE_MACHINE_ARN"]
    region = _region_from_arn(state_machine_arn)

    if session is None:
        session = boto3.Session(region_name=region)

    sfn = session.client("stepfunctions", config=config, region_name=region)

    # Always start REQUIRED_FAILURES fresh executions — never reuse a prior
    # trial's failures — so every run provably exercises the current Lambda.
    # Unique names sidestep the 90-day name-reuse rejection.
    started_arns = []
    for _ in range(REQUIRED_FAILURES):
        name = f"execution-{uuid.uuid4().hex[:12]}"
        response = sfn.start_execution(
            stateMachineArn=state_machine_arn,
            name=name,
            input='{"executionType": "scheduled"}',
        )
        started_arns.append(response["executionArn"])

    # Every freshly started execution must reach the expected FAILED state with
    # the missing-field cause, and none may be left RUNNING. Anything else is a
    # real problem (e.g. the Lambda no longer raises the error) — surface it.
    for arn in started_arns:
        desc = _wait_for_terminal(sfn, arn)
        if not _is_expected_failure(desc):
            raise RuntimeError(
                f"Execution {arn} did not reach the expected failure: "
                f"status={desc.get('status')}, error={desc.get('error')}, "
                f"cause={(desc.get('cause') or '')[:200]}"
            )

    logger.info(
        "pre_invoke complete: started %d fresh FAILED execution(s)",
        len(started_arns),
    )
    # The LLM judge grades the agent's diagnosis; no dynamic placeholders needed.
    return {}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    try:
        placeholders = run()
    except Exception as e:
        print(f"pre_invoke failed: {e}", file=sys.stderr)
        sys.exit(1)
    os.makedirs(os.path.dirname(RESULT_FILE), exist_ok=True)
    with open(RESULT_FILE, "w") as f:
        json.dump(placeholders, f)
