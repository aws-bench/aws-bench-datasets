#!/bin/bash
set -euo pipefail

REGION="us-east-1"
TABLE="${DYNAMODB_TABLE_NAME}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

ITEMS=$(aws dynamodb scan --table-name "$TABLE" --region "$REGION" \
    --projection-expression "id,workflowId,#s" \
    --expression-attribute-names '{"#s":"status"}' \
    --query "Items[].[id.S,workflowId.S,status.S]" --output text)

SAMPLE_LINES=$(echo "$ITEMS" | awk 'NF{n++; print "- Record " n ": id=" $1 ", workflowId=" $2 ", status=" $3}')
TOTAL=$(echo "$ITEMS" | awk 'NF' | wc -l | tr -d ' ')
COMPLETED=$(echo "$ITEMS" | awk '$3=="completed"' | wc -l | tr -d ' ')

WF_LINES=$(echo "$ITEMS" | awk 'NF{c[$2]++} END{for(w in c) print "- " w " (appears " c[w] " time" (c[w]==1?"":"s") ")"}' | sort)
WF_COUNT=$(echo "$ITEMS" | awk 'NF{seen[$2]=1} END{print length(seen)}')

{
    echo "Here's a summary of the $TABLE DynamoDB table:"
    echo
    echo "Sample Records ($TOTAL records):"
    echo "$SAMPLE_LINES"
    echo
    echo "Count by Criteria (status = \"completed\"):"
    echo "- $COMPLETED records have status \"completed\" (out of $TOTAL total records scanned)"
    echo
    echo "Unique Workflow IDs:"
    echo "$WF_LINES"
    echo
    echo "The table contains $TOTAL total records with $WF_COUNT unique workflow IDs."
} > "$OUT"
