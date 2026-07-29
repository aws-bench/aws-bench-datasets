#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

COUNT=$(aws dynamodb scan --region "$REGION" --table-name "$TABLE_NAME" --select COUNT --query 'Count' --output text)

RECORD=$(aws dynamodb query --region "$REGION" --table-name "$TABLE_NAME" \
    --key-condition-expression 'ContentId = :cid' \
    --expression-attribute-values "{\":cid\":{\"S\":\"$CONTENT_ID\"}}" \
    --query 'Items[0]' --output json)

TASK_ID=$(echo "$RECORD" | jq -r '.TaskId.S')
DESCRIPTION=$(echo "$RECORD" | jq -r '.Description.S')
PRIORITY=$(echo "$RECORD" | jq -r '.Priority.S')
TASK_STATUS=$(echo "$RECORD" | jq -r '.TaskStatus.S')
ASSIGNED_TO=$(echo "$RECORD" | jq -r '.AssignedTo.S')

cat > "$OUT" <<EOF
The scan of DynamoDB table $TABLE_NAME returned $COUNT items with various tasks across different priorities, statuses, and assignees. The record with ContentId $CONTENT_ID has TaskId $TASK_ID, Description '$DESCRIPTION', Priority $PRIORITY, TaskStatus $TASK_STATUS, and is assigned to $ASSIGNED_TO.
EOF
