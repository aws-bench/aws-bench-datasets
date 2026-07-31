#!/bin/bash
set -euo pipefail

REGIONS="${ALLOWED_REGIONS}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

read -ra REGION_LIST <<< "$(echo "$REGIONS" | tr ',' ' ')"

FINDINGS=""
for RAW in "${REGION_LIST[@]}"; do
    REGION="$(echo "$RAW" | tr -d '[:space:]')"
    for TABLE in $(aws dynamodb list-tables --region "$REGION" --query 'TableNames[]' --output text); do
        STREAM=$(aws dynamodb describe-kinesis-streaming-destination --region "$REGION" --table-name "$TABLE" \
            --query "KinesisDataStreamDestinations[?DestinationStatus=='ACTIVE'].StreamArn" --output text)
        [ -z "$STREAM" ] && continue
        FINDINGS="${FINDINGS}${TABLE} in the ${REGION} region"$'\n'
    done
done

JOINED=$(printf '%s' "$FINDINGS" | grep -c .)
LIST=$(printf '%s' "$FINDINGS" | grep . | paste -sd '|' - | sed 's/|/ and /g')

cat > "$OUT" <<EOF
The DynamoDB table named ${LIST} are having Kinesis streams configured.
EOF
