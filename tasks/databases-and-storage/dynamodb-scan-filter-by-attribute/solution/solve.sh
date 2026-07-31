#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

ITEMS=$(aws dynamodb scan --region "$REGION" --table-name "$TABLE_NAME" \
    --filter-expression "attribute_exists(#a)" \
    --expression-attribute-names "{\"#a\":\"$ATTRIBUTE_NAMES\"}" \
    --query "Items" --output json)

TOTAL=$(printf '%s' "$ITEMS" | jq 'length')
ACTIVE=$(printf '%s' "$ITEMS" | jq "[.[] | select(.${ATTRIBUTE_NAMES}.S == \"active\")] | length")
INACTIVE=$(printf '%s' "$ITEMS" | jq "[.[] | select(.${ATTRIBUTE_NAMES}.S == \"inactive\")] | length")

cat > "$OUT" <<EOF
The DynamoDB table $TABLE_NAME scan has been completed successfully, retrieving all items containing the specified attributes $ATTRIBUTE_NAMES. Found $TOTAL items total: $INACTIVE item with status "inactive" and $ACTIVE items with status "active".
EOF
