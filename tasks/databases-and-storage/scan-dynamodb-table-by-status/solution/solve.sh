#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

COUNT=$(aws dynamodb scan --region "$REGION" --table-name "$TABLE_NAME" --select COUNT --query 'Count' --output text)
STATUSES=$(aws dynamodb scan --region "$REGION" --table-name "$TABLE_NAME" --projection-expression "#s" --expression-attribute-names '{"#s":"status"}' --query 'Items[].status.S' --output text | tr '\t' '\n' | sort -u | paste -sd ', ' -)

printf 'The DynamoDB table %s was scanned successfully and returned %s records. The records have the following statuses: %s.\n' "$TABLE_NAME" "$COUNT" "$STATUSES" > "$OUT"
