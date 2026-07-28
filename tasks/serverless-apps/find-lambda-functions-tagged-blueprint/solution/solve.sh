#!/bin/bash
set -euo pipefail

OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

REGIONS=$(printf '%s' "${ALLOWED_REGIONS}" | tr ', ' '\n\n' | grep .)

ARNS=""
for R in $REGIONS; do
    FOUND=$(aws resourcegroupstaggingapi get-resources --region "$R" \
        --tag-filters Key=lambda-console:blueprint \
        --resource-type-filters lambda:function \
        --query "ResourceTagMappingList[].ResourceARN" --output text)
    ARNS="$ARNS $FOUND"
done

NAMES=$(printf '%s\n' $ARNS | grep . | sed 's/.*:function://')
NAME=$(printf '%s\n' $NAMES | head -n1)

printf 'The `%s` lambda function has the '"'"'lambda-console:blueprint'"'"' tag.\n' "$NAME" > "$OUT"
