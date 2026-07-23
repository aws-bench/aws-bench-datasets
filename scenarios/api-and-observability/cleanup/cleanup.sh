#!/bin/bash
# Cleanup hook for api-and-observability — teardown counterpart to deploy/deploy.sh
# (cdk deploy --all -> cdk destroy --all). Runs in the scenario container before
# the framework's own teardown (trial.py::_run_cleanup), which is authoritative.
#
# Fixed-name S3 buckets (tigris-logs-<acct>, aws-athena-query-results-<acct>-<region>)
# may survive stack deletion if the autoDeleteObjects custom resource fails during
# force-delete. Empty + delete them explicitly before CDK destroy to prevent
# "already exists" errors on redeploy.
#
# Best-effort/idempotent: never fails the phase.
set -uo pipefail

# No `set -e`, so guard cd — a failed cd must not run destroy from elsewhere.
cd /app/cdk_app || { echo "[cleanup.sh] FATAL: /app/cdk_app missing" >&2; exit 0; }

# --profile PRIMARY assumes the scenario account; CDK_DEFAULT_ACCOUNT is read by
# lib/app.ts at synth. ts-node synthesizes, so no build step is needed.
export CDK_DEFAULT_ACCOUNT="$PRIMARY"

echo "[cleanup.sh] api-and-observability teardown for account ${PRIMARY}"

# Pre-cleanup: empty and delete fixed-name S3 buckets that may survive stack deletion.
# Uses `aws s3 rb --force` which handles objects, versions, and delete markers.
FIXED_BUCKETS=(
    "tigris-logs-${PRIMARY}"
    "aws-athena-query-results-${PRIMARY}-us-east-1"
)

for bucket in "${FIXED_BUCKETS[@]}"; do
    if aws s3api head-bucket --bucket "$bucket" --profile PRIMARY 2>/dev/null; then
        echo "[cleanup.sh]   Removing fixed-name bucket: $bucket"
        aws s3 rb "s3://${bucket}" --force --profile PRIMARY 2>/dev/null || true
        echo "[cleanup.sh]   Done: $bucket"
    fi
done

npx cdk destroy --profile PRIMARY --all --force --concurrency 10 || \
    echo "[cleanup.sh]   cdk destroy incomplete; framework cleanup will finish teardown"

echo "[cleanup.sh] Done."
exit 0
