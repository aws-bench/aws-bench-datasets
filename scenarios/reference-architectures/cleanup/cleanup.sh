#!/bin/bash
# Cleanup hook for reference-architectures — teardown counterpart to deploy/deploy.sh
# (cdk deploy --all -> cdk destroy --all). Runs in the scenario container before
# the framework's own teardown (trial.py::_run_cleanup), which is authoritative.
#
# No manual S3-emptying or residual reaping: buckets use autoDeleteObjects, and
# the framework cleanup's snapshot-diff sweep + service handlers reap the rest.
# Best-effort/idempotent: never fails the phase.
set -uo pipefail

# No `set -e`, so guard cd — a failed cd must not run destroy from elsewhere.
cd /app/cdk_app || { echo "[cleanup.sh] FATAL: /app/cdk_app missing" >&2; exit 0; }

# --profile PRIMARY assumes the scenario account; CDK_DEFAULT_ACCOUNT is read by
# lib/app.ts at synth. ts-node synthesizes, so no build step is needed.
export CDK_DEFAULT_ACCOUNT="$PRIMARY"

echo "[cleanup.sh] reference-architectures teardown for account ${PRIMARY}"

# --- Batch pre-teardown -------------------------------------------------------
# Delete the job queue(s) then compute environment(s) while the VPC still exists;
# a managed CE whose VPC is already gone goes INVALID and can't be deleted.
teardown_batch_compute() {
    local region="us-east-1" jq ce i n

    for jq in $(aws batch describe-job-queues --profile PRIMARY --region "$region" \
            --query 'jobQueues[].jobQueueArn' --output text 2>/dev/null); do
        echo "[cleanup.sh]   disabling+deleting Batch job queue ${jq}"
        aws batch update-job-queue --profile PRIMARY --region "$region" \
            --job-queue "$jq" --state DISABLED >/dev/null 2>&1 || true
        for i in $(seq 1 20); do
            [ "$(aws batch describe-job-queues --profile PRIMARY --region "$region" \
                --job-queues "$jq" --query 'jobQueues[0].status' --output text 2>/dev/null)" = "VALID" ] && break
            sleep 10
        done
        aws batch delete-job-queue --profile PRIMARY --region "$region" \
            --job-queue "$jq" >/dev/null 2>&1 || true
    done
    for i in $(seq 1 30); do
        n=$(aws batch describe-job-queues --profile PRIMARY --region "$region" \
            --query 'length(jobQueues)' --output text 2>/dev/null)
        [ "$n" = "0" ] && break
        sleep 10
    done

    for ce in $(aws batch describe-compute-environments --profile PRIMARY --region "$region" \
            --query 'computeEnvironments[].computeEnvironmentArn' --output text 2>/dev/null); do
        echo "[cleanup.sh]   disabling+deleting Batch compute environment ${ce}"
        aws batch update-compute-environment --profile PRIMARY --region "$region" \
            --compute-environment "$ce" --state DISABLED >/dev/null 2>&1 || true
        for i in $(seq 1 20); do
            [ "$(aws batch describe-compute-environments --profile PRIMARY --region "$region" \
                --compute-environments "$ce" --query 'computeEnvironments[0].status' --output text 2>/dev/null)" = "VALID" ] && break
            sleep 10
        done
        aws batch delete-compute-environment --profile PRIMARY --region "$region" \
            --compute-environment "$ce" >/dev/null 2>&1 || true
    done
    for i in $(seq 1 60); do
        n=$(aws batch describe-compute-environments --profile PRIMARY --region "$region" \
            --query 'length(computeEnvironments)' --output text 2>/dev/null)
        [ "$n" = "0" ] && break
        sleep 15
    done
}
teardown_batch_compute || echo "[cleanup.sh]   Batch pre-teardown incomplete; continuing"

npx cdk destroy --profile PRIMARY --all --force --concurrency 10 || \
    echo "[cleanup.sh]   cdk destroy incomplete; framework cleanup will finish teardown"

echo "[cleanup.sh] Done."
exit 0
