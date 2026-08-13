#!/bin/bash
# Asserts the post-setup state that the framework's default verifier can't
# infer: intentionally-broken CFN stack, ECR images planted by setup scripts,
# Glue job's expected FAILED state, KMS key-policy mutation, SFN executions.
# Read-only; idempotent; safe to re-run.
set -euo pipefail

PROF="--profile PRIMARY"
errors=()

fail() { echo "FAIL: $*" >&2; errors+=("$*"); }
ok()   { echo "OK:   $*"; }

# ── 1. Trouble stack: UPDATE_FAILED with the 593/268 alias signature ────────
TROUBLE_STACK="troubleshooting-multiservice-cloudformation-t9dx4pgqw-us-east-1"
status=$(aws cloudformation describe-stacks $PROF --region us-east-1 \
    --stack-name "$TROUBLE_STACK" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "NOT_FOUND")
if [ "$status" != "UPDATE_FAILED" ]; then
    fail "$TROUBLE_STACK is '$status' (expected UPDATE_FAILED)"
elif aws cloudformation get-template $PROF --region us-east-1 \
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
' >/dev/null 2>&1; then
    ok "$TROUBLE_STACK in UPDATE_FAILED with intentional 593/268 signature"
else
    fail "$TROUBLE_STACK UPDATE_FAILED but signature does not match the setup-script mutation"
fi

# ── 2. ECR: vulnerable streamlit image present in ecrrepo ───────────────────
ACCOUNT=$(aws sts get-caller-identity $PROF --region us-east-1 --query Account --output text)
EXPECTED_ECR_TAG="a3f1c2e4-9b7d-4e8a-b6f0-2d5c8e1a4f7b_service_main"
ecr_tags=$(aws ecr list-images $PROF --region us-east-1 \
    --repository-name "ecrrepo-${ACCOUNT}-us-east-1" \
    --query 'imageIds[].imageTag' --output text 2>/dev/null || true)
if echo "$ecr_tags" | tr '\t' '\n' | grep -qx "$EXPECTED_ECR_TAG"; then
    ok "ECR ecrrepo has tag $EXPECTED_ECR_TAG"
else
    fail "ECR ecrrepo missing tag $EXPECTED_ECR_TAG (have: $ecr_tags)"
fi

# ── 3. ECR: busybox image with the single dev_build tag in basaltrepo ──────
EXPECTED_BASALT_TAG="dev_build_service_main"
basalt_tags=$(aws ecr list-images $PROF --region us-east-1 \
    --repository-name "basaltrepo-${ACCOUNT}-us-east-1" \
    --query 'imageIds[].imageTag' --output text 2>/dev/null || true)
basalt_count=$(echo "$basalt_tags" | tr '\t' '\n' | grep -c . || true)
if [ "$basalt_count" = "1" ] && echo "$basalt_tags" | tr '\t' '\n' | grep -qx "$EXPECTED_BASALT_TAG"; then
    ok "ECR basaltrepo has only $EXPECTED_BASALT_TAG"
else
    fail "ECR basaltrepo expected single tag $EXPECTED_BASALT_TAG (have: $basalt_tags)"
fi

# ── 4. Glue: most recent job run is FAILED with Lake Formation error ────────
GLUE_STACK="troubleshooting-multiservice-glue-4hc72iv0v-us-east-1"
glue_job=$(aws cloudformation describe-stacks $PROF --region us-east-1 \
    --stack-name "$GLUE_STACK" \
    --query 'Stacks[0].Outputs[?OutputKey==`GlueJobName`].OutputValue' --output text 2>/dev/null || true)
if [ -z "$glue_job" ]; then
    fail "Could not resolve GlueJobName from $GLUE_STACK outputs"
else
    last_run=$(aws glue get-job-runs $PROF --region us-east-1 \
        --job-name "$glue_job" --max-results 1 \
        --query 'JobRuns[0]' --output json 2>/dev/null || echo '{}')
    state=$(echo "$last_run" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("JobRunState",""))')
    err=$(echo "$last_run" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("ErrorMessage",""))')
    if [ "$state" = "FAILED" ] && echo "$err" | grep -qiE 'lake ?formation'; then
        ok "Glue job $glue_job latest run FAILED with Lake Formation error"
    else
        fail "Glue job $glue_job latest run state=$state, err=${err:0:80}"
    fi
fi

# ── 5. KMS: Quartz key policy has data-plane statement ─────────────────────
key_id=$(aws kms describe-key $PROF --region us-east-1 \
    --key-id "alias/quartz-${ACCOUNT}-us-east-1" \
    --query 'KeyMetadata.KeyId' --output text 2>/dev/null || true)
if [ -z "$key_id" ]; then
    fail "KMS alias/quartz-${ACCOUNT}-us-east-1 not found"
else
    statements=$(aws kms get-key-policy $PROF --region us-east-1 \
        --key-id "$key_id" --policy-name default \
        --query 'Policy' --output text \
        | python3 -c 'import json,sys;p=json.loads(sys.stdin.read());print(len(p.get("Statement",[])))')
    if [ "$statements" -ge 2 ]; then
        ok "KMS quartz key has $statements policy statements (data-plane present)"
    else
        fail "KMS quartz key has only $statements statement(s); data-plane mutation missing"
    fi
fi

# ── 6. Step Functions: deploy-time invariants for the diagnose task ─────────
# The failing executions themselves are no longer scenario state: the task
# diagnose-step-functions-failing-executions starts fresh executions in its
# pre_invoke on every trial (and asserts they reach FAILED with the missing
# 'targetBucket' field there). At scenario-verify time no executions exist yet,
# so this only confirms the deploy-time invariants pre_invoke depends on: the
# state machine and processing Lambda exist and the outputs resolve.
SFN_STACK="troubleshooting-multiservice-lambda-mw9wjm2q7-ap-southeast-2"
sm_arn=$(aws cloudformation describe-stacks $PROF --region ap-southeast-2 \
    --stack-name "$SFN_STACK" \
    --query 'Stacks[0].Outputs[?OutputKey==`StateMachineArn`].OutputValue' --output text 2>/dev/null || true)
lambda_arn=$(aws cloudformation describe-stacks $PROF --region ap-southeast-2 \
    --stack-name "$SFN_STACK" \
    --query 'Stacks[0].Outputs[?OutputKey==`ProcessingLambdaArn`].OutputValue' --output text 2>/dev/null || true)
if [ -z "$sm_arn" ] || [ "$sm_arn" = "None" ]; then
    fail "Could not resolve StateMachineArn from $SFN_STACK outputs"
elif [ -z "$lambda_arn" ] || [ "$lambda_arn" = "None" ]; then
    fail "Could not resolve ProcessingLambdaArn from $SFN_STACK outputs"
elif ! aws stepfunctions describe-state-machine $PROF --region ap-southeast-2 \
        --state-machine-arn "$sm_arn" >/dev/null 2>&1; then
    fail "State machine $sm_arn does not exist or is not describable"
elif ! aws lambda get-function $PROF --region ap-southeast-2 \
        --function-name "$lambda_arn" >/dev/null 2>&1; then
    fail "Processing Lambda $lambda_arn does not exist"
else
    ok "State machine and processing Lambda exist (executions are started per-trial by the task pre_invoke)"
fi

# ── Result ──────────────────────────────────────────────────────────────────
if [ "${#errors[@]}" -gt 0 ]; then
    echo
    echo "verify failed: ${#errors[@]} check(s) did not pass" >&2
    for e in "${errors[@]}"; do echo "  - $e" >&2; done
    exit 1
fi
echo
echo "All scenario-specific assertions passed."
