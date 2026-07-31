#!/bin/bash
set -euo pipefail

REGION="us-west-2"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

COUNT=$(aws sns list-subscriptions --region "$REGION" --output json \
    | jq '[.Subscriptions[] | select(.Protocol == "sqs")] | length')

cat > "$OUT" <<EOF
You have total of ${COUNT} subscribers subscribed to the topics.
EOF
