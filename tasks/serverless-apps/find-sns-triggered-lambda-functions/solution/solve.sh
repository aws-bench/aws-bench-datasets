#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

# The ECS drain hook names its topic ...LifecycleHookDrainHookTopic... and its
# function ...DrainECSHookFunction..., so neither spelling alone matches both
# sides; the shared "Drain" stem is checked on the topic and on the endpoint.
SUBS=$(aws sns list-subscriptions --region "$REGION" \
    --query "Subscriptions[?Protocol=='lambda' && !contains(TopicArn,'Drain') && !contains(Endpoint,'Drain')].[Endpoint,TopicArn]" \
    --output text)

# Report a filter that stopped excluding the drain hook as a failure rather than
# emitting an extra function, which reads as a wrong resource count.
SUB_COUNT=$(printf '%s\n' "$SUBS" | grep -c . || true)
if [ "$SUB_COUNT" -ne 1 ]; then
    echo "expected exactly 1 non-drain-hook lambda subscription, found ${SUB_COUNT}:" >&2
    printf '%s\n' "$SUBS" >&2
    exit 1
fi

{
    printf 'The following lambda is triggered by SNS:\n'
    printf '%s\n' "$SUBS" | while read -r ENDPOINT TOPIC_ARN; do
        FUNC="${ENDPOINT##*:function:}"
        TOPIC="${TOPIC_ARN##*:}"
        printf ' %s\n' "$FUNC"
        printf '  - Triggered by SNS topic: %s\n' "$TOPIC"
    done
} > "$OUT"
