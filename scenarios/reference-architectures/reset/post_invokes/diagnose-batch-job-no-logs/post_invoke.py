"""Post-invoke for diagnose-batch-job-no-logs.

Terminates the job this trial's pre-invoke submitted, if it is still active, so
no submission outlives the trial and the EC2-backed compute environment scales
back to zero. Jobs this trial did not create are left alone, so concurrent
attempts of this task never cancel each other's work.

Completed Batch job history cannot be deleted, so the FAILED job stays visible.
That is inert: the queue holds no runnable work afterwards.

Idempotent: an unresolved job id, an already-terminal job, and a torn-down stack
are all treated as already clean.

Env vars (from ``[post_invoke.env]`` in task.toml):
    BATCH_JOB_ID  Job submitted by pre-invoke, via its emitted placeholder.
    AWS_REGION    Region the stack lives in.
"""

import logging
import os
import sys
import time

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

# States a job can sit in while still holding queue or compute capacity.
ACTIVE_STATES = ("SUBMITTED", "PENDING", "RUNNABLE", "STARTING", "RUNNING")

DRAIN_TIMEOUT_SEC = 300
POLL_INTERVAL_SEC = 10

# Batch error codes meaning the queue or job is already gone.
GONE_CODES = ("ClientException", "ResourceNotFoundException")


def _status(batch, job_id: str) -> str | None:
    """Return the job's status, or None when Batch no longer knows the id."""
    jobs = batch.describe_jobs(jobs=[job_id])["jobs"]
    return jobs[0]["status"] if jobs else None


def run() -> None:
    region = os.environ["AWS_REGION"]

    job_id = os.environ.get("BATCH_JOB_ID", "").strip()
    # Pre-invoke failed before emitting the placeholder, so the token never
    # resolved and there is no job of ours to clean up.
    if not job_id or job_id.startswith("{{"):
        logger.info(f"no resolved BATCH_JOB_ID ({job_id!r}); nothing to terminate")
        return

    batch = boto3.client("batch", region_name=region)

    try:
        status = _status(batch, job_id)
        if status is None:
            logger.info(f"job {job_id} unknown to Batch; nothing to terminate")
            return
        if status not in ACTIVE_STATES:
            logger.info(f"job {job_id} already terminal ({status})")
            return

        batch.terminate_job(jobId=job_id, reason="aws-bench post_invoke cleanup")
        logger.info(f"terminated {job_id} (was {status})")
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") in GONE_CODES:
            logger.info(f"job {job_id} or its queue is gone; nothing to drain")
            return
        raise

    # Wait for the termination to land so the compute environment releases its
    # instances before env verify scans EC2.
    deadline = time.monotonic() + DRAIN_TIMEOUT_SEC
    status = None
    while time.monotonic() < deadline:
        status = _status(batch, job_id)
        if status is None or status not in ACTIVE_STATES:
            logger.info(f"job {job_id} settled ({status})")
            return
        time.sleep(POLL_INTERVAL_SEC)
    raise TimeoutError(
        f"job {job_id} still active ({status}) after {DRAIN_TIMEOUT_SEC}s"
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    try:
        run()
    except (ClientError, KeyError, TimeoutError) as e:
        print(f"post_invoke failed: {e}", file=sys.stderr)
        sys.exit(1)
