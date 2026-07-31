#!/bin/bash
set -euo pipefail

OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

: > "$OUT"
for REGION in us-east-1 us-west-2; do
    for TABLE in $(aws dynamodb list-tables --region "$REGION" --query 'TableNames[]' --output text); do
        ARN=$(aws dynamodb describe-table --region "$REGION" --table-name "$TABLE" --query 'Table.TableArn' --output text)
        POLICY=$(aws dynamodb get-resource-policy --region "$REGION" --resource-arn "$ARN" --query 'Policy' --output text 2>/dev/null || true)
        if [ -n "$POLICY" ]; then
            echo "The DynamoDB table named ${TABLE} in the ${REGION} region has a resource-based policy." >> "$OUT"
        fi
    done
done
