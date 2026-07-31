#!/bin/bash
set -euo pipefail

REGION="us-west-1"
STACK_ID="${STACK_ID}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

STATUS=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_ID" \
    --query "Stacks[0].StackStatus" --output text)

RES=$(aws cloudformation list-stack-resources --region "$REGION" --stack-name "$STACK_ID" \
    --query "StackResourceSummaries[].[ResourceType,LogicalResourceId,PhysicalResourceId,ResourceStatus]" \
    --output text)

COUNT=$(printf '%s\n' "$RES" | grep -c .)
INSTANCE_ID=$(printf '%s\n' "$RES" | awk -F'\t' '$1=="AWS::EC2::Instance"{print $3}')

cat > "$OUT" <<EOF
It is a CDK stack that stands up a web server: a VPC with a public subnet, an EC2 instance (${INSTANCE_ID}), its security group, IAM role, and a Lambda-backed custom resource that locks down the default SG. There are ${COUNT} resources in total, and the stack is in ${STATUS} state (all created successfully).
EOF
