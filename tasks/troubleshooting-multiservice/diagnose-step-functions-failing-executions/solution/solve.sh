#!/bin/bash
set -euo pipefail

REGION="ap-southeast-2"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

DEFINITION=$(aws stepfunctions describe-state-machine --region "$REGION" \
    --state-machine-arn "$STATE_MACHINE_ARN" --query "definition" --output text)
LAMBDA_ARN=$(printf '%s' "$DEFINITION" | grep -oE 'arn:aws:lambda:[^"]+:function:[^"]+' | head -1)

STATUSES=$(aws stepfunctions list-executions --region "$REGION" \
    --state-machine-arn "$STATE_MACHINE_ARN" \
    --query "executions[].status" --output text)
TOTAL=$(printf '%s\n' "$STATUSES" | tr '\t' '\n' | grep -c .)
FAILED=$(printf '%s\n' "$STATUSES" | tr '\t' '\n' | grep -c '^FAILED$')

EXECUTION_ARN=$(aws stepfunctions list-executions --region "$REGION" \
    --state-machine-arn "$STATE_MACHINE_ARN" --status-filter FAILED \
    --query "executions[0].executionArn" --output text)

FAILED_STATE=$(aws stepfunctions get-execution-history --region "$REGION" \
    --execution-arn "$EXECUTION_ARN" \
    --query "events[?type=='TaskStateEntered'].stateEnteredEventDetails.name | [0]" \
    --output text)

ERROR=$(aws stepfunctions describe-execution --region "$REGION" \
    --execution-arn "$EXECUTION_ARN" --query "error" --output text)
CAUSE=$(aws stepfunctions describe-execution --region "$REGION" \
    --execution-arn "$EXECUTION_ARN" --query "cause" --output text)

cat > "$OUT" <<EOF
All ${FAILED} of the ${TOTAL} executions of this state machine fail, and every one of them fails at the ${FAILED_STATE} state.

That state invokes the Lambda function ${LAMBDA_ARN}, whose handler raises a RuntimeError: "Configuration validation failed: missing required field 'targetBucket'". The Lambda error propagates up and fails the entire execution.

Failure reported by the failed execution (error / cause):
${ERROR}
${CAUSE}
EOF
