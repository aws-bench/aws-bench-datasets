#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

COUNT=$(aws dynamodb scan \
    --table-name "$TABLE_NAME" \
    --region "$REGION" \
    --filter-expression "tag = :empty_tag AND ResolvedAt > :zero" \
    --expression-attribute-values '{":empty_tag":{"S":""},":zero":{"N":"0"}}' \
    --select COUNT \
    --query Count \
    --output text)

cat > "$OUT" <<EOF
There are $COUNT records with the specified attributes (an empty tag field and a ResolvedAt value greater than zero) in the DynamoDB table $TABLE_NAME.
EOF
