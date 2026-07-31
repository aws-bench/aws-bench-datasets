#!/bin/bash
set -euo pipefail

BOOTSTRAP_REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

REGIONS=$(aws ec2 describe-regions --region "$BOOTSTRAP_REGION" \
    --query "Regions[].RegionName" --output text | tr '\t' '\n' | sort)

: > "$OUT"
TOTAL=0
for REGION in $REGIONS; do
    LIST=$(aws dynamodb list-tables --region "$REGION" \
        --query "TableNames" --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)
    ACTIVE=0
    ACTIVE_NAMES=""
    for T in $LIST; do
        STATUS=$(aws dynamodb describe-table --region "$REGION" --table-name "$T" \
            --query "Table.TableStatus" --output text)
        if [ "$STATUS" = "ACTIVE" ]; then
            ACTIVE=$((ACTIVE + 1))
            ACTIVE_NAMES="${ACTIVE_NAMES}${T}, "
        fi
    done
    if [ "$ACTIVE" -gt 0 ]; then
        ACTIVE_NAMES=${ACTIVE_NAMES%, }
        TOTAL=$((TOTAL + ACTIVE))
        printf 'In %s there are %s active DynamoDB tables: %s.\n' "$REGION" "$ACTIVE" "$ACTIVE_NAMES" >> "$OUT"
    fi
done

printf '\nAcross all AWS regions there are %s active DynamoDB tables total; every other region has none.\n' "$TOTAL" >> "$OUT"
