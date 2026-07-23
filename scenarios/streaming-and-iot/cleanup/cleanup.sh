#!/bin/bash
# Cleanup hook for streaming-and-iot — teardown counterpart to deploy/deploy.sh
# (cdk deploy --all -> cdk destroy --all). Runs in the scenario container before
# the framework's own teardown (trial.py::_run_cleanup), which is authoritative.
#
# No manual S3-emptying or residual reaping: buckets use autoDeleteObjects, and
# the framework cleanup's snapshot-diff sweep + service handlers reap the rest
# (incl. the DMS ENIs / S3 Tables bucket that reset.sh handles for the RESET path).
# Best-effort/idempotent: never fails the phase.
set -uo pipefail

# No `set -e`, so guard cd — a failed cd must not run destroy from elsewhere.
cd /app/cdk_app || { echo "[cleanup.sh] FATAL: /app/cdk_app missing" >&2; exit 0; }

# --profile PRIMARY assumes the scenario account; CDK_DEFAULT_ACCOUNT is read by
# lib/app.ts at synth. ts-node synthesizes, so no build step is needed.
export CDK_DEFAULT_ACCOUNT="$PRIMARY"

echo "[cleanup.sh] streaming-and-iot teardown for account ${PRIMARY}"
npx cdk destroy --profile PRIMARY --all --force --concurrency 10 || \
    echo "[cleanup.sh]   cdk destroy incomplete; framework cleanup will finish teardown"

echo "[cleanup.sh] Done."
exit 0
