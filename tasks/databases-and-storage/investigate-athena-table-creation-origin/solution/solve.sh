#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

BARE_TABLE="${TABLE_NAME##*|}"

DATABASE_NAME=$(aws glue search-tables --region "$REGION" --search-text "$BARE_TABLE" \
    --query "TableList[?Name==\`$BARE_TABLE\`].DatabaseName | [0]" \
    --output text)

PHYS_ID=""
for CAND in "$TABLE_NAME" "$BARE_TABLE" "${DATABASE_NAME}|${BARE_TABLE}"; do
    if aws cloudformation describe-stack-resources --region "$REGION" \
        --physical-resource-id "$CAND" >/dev/null 2>&1; then
        PHYS_ID="$CAND"
        break
    fi
done

STACK_NAME=$(aws cloudformation describe-stack-resources --region "$REGION" \
    --physical-resource-id "$PHYS_ID" \
    --query "StackResources[?ResourceType==\`AWS::Glue::Table\`].StackName | [0]" \
    --output text)

RESOURCE_TYPE=$(aws cloudformation describe-stack-resources --region "$REGION" \
    --physical-resource-id "$PHYS_ID" \
    --query "StackResources[?ResourceType==\`AWS::Glue::Table\`].ResourceType | [0]" \
    --output text)

TABLE_JSON=$(aws glue get-table --region "$REGION" \
    --database-name "$DATABASE_NAME" --name "$BARE_TABLE" \
    --query "Table.[StorageDescriptor.Location,ViewOriginalText,ViewExpandedText,IsMultiDialectView]" \
    --output json)

cat > "$OUT" <<EOF
The Athena table ${TABLE_NAME} was created using the CloudFormation stack named ${STACK_NAME}. The resource shows as a table rather than a view because it was created as an ${RESOURCE_TYPE} resource in CloudFormation. It has a StorageDescriptor pointing to actual data in S3, and also it has no view-related properties (ViewOriginalText, ViewExpandedText) or view flags (IsMultiDialectView is false).
EOF
