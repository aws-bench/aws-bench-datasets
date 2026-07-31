#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

BUCKETS=$(aws s3api list-buckets --region "$REGION" \
    --query "sort_by(Buckets[?starts_with(Name, 'bucket') && Name >= 'bucket0' && Name < 'bucket:'], &Name)[].Name" \
    --output text)

MISSING=()
for b in $BUCKETS; do
    CONFIGS=$(aws s3api list-bucket-intelligent-tiering-configurations --bucket "$b" --region "$REGION" \
        --query 'IntelligentTieringConfigurationList' --output text)
    if [ "$CONFIGS" = "None" ]; then
        MISSING+=("$b")
    fi
done

COUNT=${#MISSING[@]}
NAMES=$(printf '%s and ' "${MISSING[@]}")
NAMES=${NAMES% and }

echo "You have $COUNT S3 buckets without Intelligent-Tiering configurations currently in your account named $NAMES." > "$OUT"
