#!/bin/bash
set -euo pipefail

cd /app/cdk_app

# aws-bench wrote ~/.aws/config with PRIMARY profile + $PRIMARY env var.
export CDK_DEFAULT_ACCOUNT="$PRIMARY"

REGIONS=(us-east-1 us-west-2 eu-west-1 eu-central-1 ap-northeast-1 ap-northeast-2 ap-southeast-2)
TROUBLE_STACK="troubleshooting-multiservice-cloudformation-t9dx4pgqw-us-east-1"

# ── Idempotency guard for the intentionally-broken CFN stack ────────────────
# setup_cloudformation_t9dx4pgqw.py drives this stack into UPDATE_FAILED by
# rewriting Lambda::Alias FunctionVersion to '593' (SimpleEmailService) and
# '268' (GetDetectorOutcome). On a re-run of `aws-bench env setup`, CDK would
# fight that broken state. We exclude it from `cdk deploy` only when the
# UPDATE_FAILED has the expected signature; any other failure mode is a real
# bug we want to surface, not silently skip.
exclude_trouble_stack=0
status=$(aws cloudformation describe-stacks --profile PRIMARY --region us-east-1 \
    --stack-name "$TROUBLE_STACK" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "NOT_FOUND")

case "$status" in
    NOT_FOUND|CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE)
        echo "$TROUBLE_STACK status=$status — will deploy normally."
        ;;
    UPDATE_FAILED)
        # Confirm the failure is the intentional one (FunctionVersion 593/268
        # on at least one Lambda::Alias). If not, abort — operator investigates.
        if aws cloudformation get-template --profile PRIMARY --region us-east-1 \
                --stack-name "$TROUBLE_STACK" --template-stage Original \
                --query 'TemplateBody' --output json \
            | python3 -c '
import json, sys
tpl = json.load(sys.stdin)
if isinstance(tpl, str):
    tpl = json.loads(tpl)
for r in tpl.get("Resources", {}).values():
    if r.get("Type") == "AWS::Lambda::Alias":
        if r.get("Properties", {}).get("FunctionVersion") in ("593", "268"):
            sys.exit(0)
sys.exit(1)
'; then
            echo "$TROUBLE_STACK is in intentional UPDATE_FAILED — excluding from cdk deploy."
            exclude_trouble_stack=1
        else
            echo "ERROR: $TROUBLE_STACK is UPDATE_FAILED but signature does not" >&2
            echo "match the intentional setup-script mutation. Investigate." >&2
            exit 1
        fi
        ;;
    *)
        echo "ERROR: $TROUBLE_STACK in unexpected state '$status'. Aborting." >&2
        exit 1
        ;;
esac

npm run build

for region in "${REGIONS[@]}"; do
    npx cdk bootstrap --profile PRIMARY "aws://${PRIMARY}/${region}"
done

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

if [ "$exclude_trouble_stack" -eq 1 ]; then
    # cdk has no native --exclude flag; deploy the explicit list instead.
    # Use command substitution so a failure in `cdk list` aborts under set -e
    # — process substitution does not propagate exit codes and would let an
    # empty list silently deploy zero stacks.
    ALL_STACKS_OUTPUT=$(npx cdk list)
    if [ -z "$ALL_STACKS_OUTPUT" ]; then
        echo "ERROR: cdk list returned no stacks" >&2
        exit 1
    fi
    mapfile -t ALL_STACKS <<< "$ALL_STACKS_OUTPUT"
    DEPLOY_STACKS=()
    for s in "${ALL_STACKS[@]}"; do
        [ "$s" = "$TROUBLE_STACK" ] || DEPLOY_STACKS+=("$s")
    done
    echo "Deploying ${#DEPLOY_STACKS[@]} stacks (excluding $TROUBLE_STACK)..."
    cdk_deploy --profile PRIMARY --require-approval never --concurrency 20 "${DEPLOY_STACKS[@]}"
else
    cdk_deploy --profile PRIMARY --all --require-approval never --concurrency 20
fi

# Setup scripts touch disjoint resources, so we fan out to script-count
# parallelism. Each script does its own boto3.Session(profile_name="PRIMARY")
# because the framework injects management creds via env vars that would
# otherwise win against AWS_PROFILE.
export AWS_PROFILE=PRIMARY
SETUP_DIR="/app/cdk_app/setup"

scripts=()
for script in "$SETUP_DIR"/setup_*.py; do
    [ -f "$script" ] || continue
    scripts+=("$script")
done

MAX_PARALLEL=${#scripts[@]}
echo "Running ${#scripts[@]} setup script(s) with parallelism=$MAX_PARALLEL"

failed=()
pids=()
names=()

reap_one() {
    REAPED_PID=0
    # Under set -e, bash aborts between `wait -n` and `status=$?` when wait
    # returns the child's non-zero exit. Wrap in `&& ... || ...` to keep wait
    # in an inspected-exit-code context so errexit doesn't fire.
    wait -n -p REAPED_PID "${pids[@]}" 2>/dev/null && status=0 || status=$?
    for i in "${!pids[@]}"; do
        if [ "${pids[$i]}" -eq "$REAPED_PID" ]; then
            if [ "$status" -ne 0 ]; then
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
}

for script in "${scripts[@]}"; do
    name=$(basename "$script")
    while [ "${#pids[@]}" -ge "$MAX_PARALLEL" ]; do
        reap_one
    done
    echo "--- $name (background) ---"
    python3 "$script" &
    pids+=($!)
    names+=("$name")
done

while [ "${#pids[@]}" -gt 0 ]; do
    reap_one
done

if [ "${#failed[@]}" -gt 0 ]; then
    echo "Setup scripts failed: ${failed[*]}" >&2
    exit 1
fi

# Confirm setup_cloudformation_t9dx4pgqw left the trouble stack UPDATE_FAILED.
final_status=$(aws cloudformation describe-stacks --profile PRIMARY --region us-east-1 \
    --stack-name "$TROUBLE_STACK" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "NOT_FOUND")
if [ "$final_status" != "UPDATE_FAILED" ]; then
    echo "ERROR: post-setup, $TROUBLE_STACK is in '$final_status' (expected UPDATE_FAILED)." >&2
    exit 1
fi
echo "All setup scripts completed; $TROUBLE_STACK is in UPDATE_FAILED as expected."
