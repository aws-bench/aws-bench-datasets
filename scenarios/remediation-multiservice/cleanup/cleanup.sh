#!/bin/bash
# Master cleanup for the remediation-multiservice scenario.
#
# All candidates share one CDK app under /app/cdk_app, so teardown is three
# ordered stages:
#
#   1. every candidate's `pre` sweep — work that must happen while the stacks
#      still exist (scaling ECS services to zero, emptying versioned buckets,
#      stripping out-of-band IAM policies, restoring KMS root administration,
#      draining queues, stopping builds)
#   2. one `cdk destroy --all` for the whole app
#   3. every candidate's `post` sweep — residue CloudFormation does not own
#
# Every `pre` sweep must complete before the single destroy, so no candidate
# destroys anything itself. All phases are best-effort.
set -uo pipefail

# CDK_DEFAULT_ACCOUNT stays valid after the assumed-role credentials expire
# mid-cleanup.
export CDK_DEFAULT_ACCOUNT="$PRIMARY"

CLEANUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANDIDATES_DIR="${CLEANUP_DIR}/candidates"

run_phase() {
    local phase="$1"
    for script in "${CANDIDATES_DIR}"/*.sh; do
        [ -f "$script" ] || continue
        echo ""
        echo "########################################################"
        echo "### cleanup ${phase}: $(basename "$script")"
        echo "########################################################"
        bash "$script" "$phase" ||
            echo "WARNING: $(basename "$script") ${phase} exited non-zero (continuing)"
    done
}

echo "########## STAGE 1: pre-destroy sweeps ##########"
run_phase pre

echo ""
echo "########## STAGE 2: cdk destroy --all ##########"
cd /app/cdk_app
npx cdk destroy --profile PRIMARY --all --force --concurrency 10 2>&1 || true

echo ""
echo "########## STAGE 3: post-destroy sweeps ##########"
run_phase post

echo ""
echo "All candidate cleanups complete."
exit 0
