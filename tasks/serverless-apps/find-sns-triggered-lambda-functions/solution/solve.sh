#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

SUBS=$(aws sns list-subscriptions --region "$REGION" \
    --query "Subscriptions[?Protocol=='lambda' && !contains(TopicArn,'DrainHook')].[Endpoint,TopicArn]" \
    --output text)

{
    printf 'The following lambda is triggered by SNS:\n'
    printf '%s\n' "$SUBS" | while read -r ENDPOINT TOPIC_ARN; do
        FUNC="${ENDPOINT##*:function:}"
        TOPIC="${TOPIC_ARN##*:}"
        printf ' %s\n' "$FUNC"
        printf '  - Triggered by SNS topic: %s\n' "$TOPIC"
    done
} > "$OUT"
