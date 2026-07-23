#!/bin/bash
set -euo pipefail

cd /app/cdk_app

export CDK_DEFAULT_ACCOUNT="$PRIMARY"

npm run build

for region in us-east-1 us-west-2 ap-southeast-1; do
    npx cdk bootstrap --profile PRIMARY "aws://${PRIMARY}/${region}"
done

# Pre-deploy: purge ORPHANED fixed-name S3 buckets left behind by a failed
# stack delete (the autoDeleteObjects custom resource can lose its bucket-policy
# grant across stack incarnations and fail with AccessDenied; FORCE_DELETE_STACK
# then abandons the buckets). An orphaned bucket makes cdk deploy fail changeset
# validation with "already exists", which loops reset->redeploy forever.
#
# Only buckets whose OWNING STACK is absent (or a REVIEW_IN_PROGRESS shell from
# a failed changeset) are deleted — if the stack is healthy, the buckets are
# live resources of an idempotent redeploy and must not be touched.
# Best-effort: a purge failure falls through to cdk deploy, which fails no
# worse than before.
# Best-effort by construction: the entire purge runs in a subshell with set +e
# and its exit status is ignored, so NO failure here can fail the deploy phase.
# Worst case the purge is skipped and cdk deploy fails with "already exists"
# exactly as it would have without this block.
(
    set +e +o pipefail
    ECS_STACK="api-and-observability-ecs-t81xcoww7-us-east-1"
    FIXED_BUCKETS=(
        "tigris-logs-${PRIMARY}"
        "aws-athena-query-results-${PRIMARY}-us-east-1"
    )
    # Fail CLOSED: only the specific "does not exist" ValidationError means the
    # stack is absent. Any other describe-stacks failure (throttle, credentials,
    # network) must NOT be read as absence — purging a healthy stack's buckets
    # would be destructive — so skip the purge and let cdk deploy proceed.
    if stack_status=$(aws cloudformation describe-stacks --stack-name "$ECS_STACK" \
        --region us-east-1 --profile PRIMARY \
        --query 'Stacks[0].StackStatus' --output text 2>&1); then
        : # live stack; stack_status holds its real status
    elif [[ "$stack_status" == *"does not exist"* ]]; then
        stack_status="ABSENT"
    else
        echo "[deploy.sh] WARN: describe-stacks failed (${stack_status}); skipping orphan-bucket purge"
        stack_status="UNKNOWN"
    fi
    if [ "$stack_status" = "ABSENT" ] || [ "$stack_status" = "REVIEW_IN_PROGRESS" ]; then
        for bucket in "${FIXED_BUCKETS[@]}"; do
            if aws s3api head-bucket --bucket "$bucket" --profile PRIMARY 2>/dev/null; then
                echo "[deploy.sh] Purging orphaned fixed-name bucket (owner stack ${stack_status}): $bucket"
                aws s3 rb "s3://${bucket}" --force --profile PRIMARY
            fi
        done
    fi
) || true

# One retry for transient create races: IAM propagation can lag role creation
# enough that Lambda CreateFunction fails ("The role defined for the function
# cannot be assumed by Lambda"), rolling the stack back to ROLLBACK_COMPLETE.
# On the retry, cdk deletes the creation-failed stack and recreates it;
# already-completed stacks are no-op'd.
cdk_deploy() {
    if ! npx cdk deploy "$@"; then
        echo "cdk deploy failed; retrying once for transient CFN/IAM races..." >&2
        npx cdk deploy "$@"
    fi
}

cdk_deploy --profile PRIMARY --all --require-approval never --concurrency 10

# Run post-deploy setup scripts
echo "Running setup scripts..."
export AWS_PROFILE=PRIMARY
SETUP_DIR="/app/setup"
MAX_PARALLEL=13

scripts=()
for script in "$SETUP_DIR"/setup_*.py; do
    [ -f "$script" ] || continue
    scripts+=("$script")
done

if [ ${#scripts[@]} -eq 0 ]; then
    echo "No setup scripts found."
    exit 0
fi

echo "Running ${#scripts[@]} setup script(s) with parallelism=$MAX_PARALLEL"

failed=()
pids=()
names=()

for script in "${scripts[@]}"; do
    name=$(basename "$script")

    while [ ${#pids[@]} -ge $MAX_PARALLEL ]; do
        REAPED_PID=0
        wait -n -p REAPED_PID "${pids[@]}" 2>/dev/null && status=0 || status=$?
        for i in "${!pids[@]}"; do
            if [ "${pids[$i]}" -eq "$REAPED_PID" ]; then
                if [ $status -ne 0 ]; then
                    echo "  FAILED: ${names[$i]}" >&2
                    failed+=("${names[$i]}")
                else
                    echo "  OK: ${names[$i]}"
                fi
                unset 'pids[$i]' 'names[$i]'
                break
            fi
        done
        pids=("${pids[@]}")
        names=("${names[@]}")
    done

    echo "--- $name (background) ---"
    python3 "$script" &
    pids+=($!)
    names+=("$name")
done

while [ ${#pids[@]} -gt 0 ]; do
    REAPED_PID=0
    wait -n -p REAPED_PID "${pids[@]}" 2>/dev/null && status=0 || status=$?
    for i in "${!pids[@]}"; do
        if [ "${pids[$i]}" -eq "$REAPED_PID" ]; then
            if [ $status -ne 0 ]; then
                echo "  FAILED: ${names[$i]}" >&2
                failed+=("${names[$i]}")
            else
                echo "  OK: ${names[$i]}"
            fi
            unset 'pids[$i]' 'names[$i]'
            break
        fi
    done
    pids=("${pids[@]}")
    names=("${names[@]}")
done

if [ ${#failed[@]} -gt 0 ]; then
    echo "Setup failed: ${failed[*]}" >&2
    exit 1
fi
echo "All setup scripts completed."
