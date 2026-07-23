#!/bin/bash
# Cleanup hook for serverless-apps — teardown counterpart to deploy/deploy.sh
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

echo "[cleanup.sh] serverless-apps teardown for account ${PRIMARY}"
timeout 1800 npx cdk destroy --profile PRIMARY --all --force --concurrency 20 || \
    echo "[cleanup.sh]   cdk destroy incomplete; framework cleanup will finish teardown"

echo "[cleanup.sh] Done."
exit 0
