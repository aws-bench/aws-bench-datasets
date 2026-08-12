"""Pre-invoke for diagnose-batch-job-no-logs.

Creates the runtime event the instruction describes: invokes the submit Lambda
once and waits for the job it returns to reach FAILED with a container
image-pull error. The stack ships the defects (untagged image URI against an
empty ECR repository) but deploys no job, so without this hook the account has
no job history for the agent to describe.

Fails closed when the job fails for any reason other than the image pull, so a
capacity or IAM failure never masquerades as the intended defect.

Every assertion is scoped to the job id this invocation returns; jobs on the
queue that this run did not create are left untouched, so concurrent attempts of
this task cannot cancel each other.

Env vars (from ``[pre_invoke.env]`` in task.toml):
    FUNCTION_NAME  Lambda that submits the Batch job.
    AWS_REGION     Region the stack lives in.
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

# Emitted so the solution and post-invoke act on this run's job rather than on
# whatever the queue's newest job happens to be. Prefix is the task's metadata id.
JOB_ID_PLACEHOLDER = "deca76d5-BatchJobId"

# Batch reaches STARTING then FAILED once it tries to pull the missing image.
# An EC2-backed queue must scale from zero first, which dominates this budget.
FAIL_TIMEOUT_SEC = 900
POLL_INTERVAL_SEC = 15

TERMINAL_STATES = ("SUCCEEDED", "FAILED")

# States a job can sit in while still holding queue or compute capacity.
ACTIVE_STATES = ("SUBMITTED", "PENDING", "RUNNABLE", "STARTING", "RUNNING")

# statusReason fragments Batch uses when the image cannot be pulled. Matched
# case-insensitively against the job's statusReason plus its attempt reasons.
IMAGE_PULL_MARKERS = (
    "manifest",
    "image",
    "cannotpull",
    "not found",
    "does not exist",
)


def _submit(lambda_client, function_name: str) -> str:
    """Invoke the submit Lambda and return the job id it reports."""
    response = lambda_client.invoke(
        FunctionName=function_name,
        InvocationType="RequestResponse",
    )
    if response.get("FunctionError"):
        raise RuntimeError(
            f"{function_name} returned FunctionError={response['FunctionError']}: "
            f"{response['Payload'].read().decode('utf-8', 'replace')[:400]}"
        )

    payload = json.loads(response["Payload"].read())
    # The handler returns {"statusCode": 200, "body": "<json string>"}.
    body = payload.get("body")
    if isinstance(body, str):
        body = json.loads(body)
    job_id = (body or {}).get("jobId")
    if not job_id:
        raise RuntimeError(f"{function_name} returned no jobId: {payload!r}")
    logger.info(f"{function_name} submitted job {job_id}")
    return job_id


def _reasons(job: dict) -> str:
    """Collect the job's statusReason and every attempt's reason into one blob."""
    parts = [job.get("statusReason", "")]
    for attempt in job.get("attempts", []):
        parts.append(attempt.get("statusReason", ""))
        parts.append(attempt.get("container", {}).get("reason", ""))
    return " | ".join(p for p in parts if p)


def _wait_for_expected_failure(batch, job_id: str) -> str:
    """Poll one job to a terminal state; return its reason blob.

    Raises when the job succeeds, when it fails for a reason unrelated to the
    image pull, or when it does not settle inside the timeout.
    """
    deadline = time.monotonic() + FAIL_TIMEOUT_SEC
    status = "UNKNOWN"
    while time.monotonic() < deadline:
        jobs = batch.describe_jobs(jobs=[job_id])["jobs"]
        if not jobs:
            raise RuntimeError(f"job {job_id} disappeared from describe_jobs")
        job = jobs[0]
        status = job["status"]
        reasons = _reasons(job)
        logger.info(f"job {job_id}: {status} {reasons[:160]}")

        if status == "SUCCEEDED":
            raise RuntimeError(
                f"job {job_id} SUCCEEDED; the scenario's empty-ECR defect is gone "
                f"(an image was pushed to the repository)"
            )
        if status == "FAILED":
            blob = reasons.lower()
            if any(marker in blob for marker in IMAGE_PULL_MARKERS):
                return reasons
            raise RuntimeError(
                f"job {job_id} FAILED for an unintended reason: {reasons[:400]}"
            )
        time.sleep(POLL_INTERVAL_SEC)

    raise TimeoutError(
        f"job {job_id} did not reach {'/'.join(TERMINAL_STATES)} in "
        f"{FAIL_TIMEOUT_SEC}s (last status {status})"
    )


def run() -> dict[str, str]:
    function_name = os.environ["FUNCTION_NAME"]
    job_queue = os.environ["JOB_QUEUE_ARN"]
    region = os.environ["AWS_REGION"]

    batch = boto3.client("batch", region_name=region)
    lambda_client = boto3.client("lambda", region_name=region)

    # Terminate anything a previous run left active so this run's job is the only
    # one on the queue and no stale submission keeps the compute environment warm.
    # Trials of this task are serialized by its mutating concurrency mode, so this
    # cannot cancel a sibling trial's work.
    for status in ACTIVE_STATES:
        paginator = batch.get_paginator("list_jobs")
        for page in paginator.paginate(jobQueue=job_queue, jobStatus=status):
            for job in page.get("jobSummaryList", []):
                batch.terminate_job(
                    jobId=job["jobId"], reason="aws-bench pre_invoke reset"
                )
                logger.info(f"terminated stale {status} job {job['jobId']}")

    job_id = _submit(lambda_client, function_name)
    reasons = _wait_for_expected_failure(batch, job_id)
    logger.info(f"job {job_id} FAILED as intended: {reasons[:200]}")
    return {JOB_ID_PLACEHOLDER: job_id}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    try:
        placeholders = run()
    except (ClientError, KeyError, RuntimeError, TimeoutError) as e:
        print(f"pre_invoke failed: {e}", file=sys.stderr)
        sys.exit(1)
    os.makedirs(os.path.dirname(RESULT_FILE), exist_ok=True)
    with open(RESULT_FILE, "w") as f:
        json.dump(placeholders, f, indent=2)
