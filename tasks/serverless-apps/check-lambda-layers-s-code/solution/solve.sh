#!/bin/bash
set -euo pipefail

OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

REGIONS=$(printf '%s' "${ALLOWED_REGIONS}" | tr ', ' '\n\n' | grep .)

S3_ARNS=""
for R in $REGIONS; do
    LAYER_NAMES=$(aws lambda list-layers --region "$R" \
        --query "Layers[].LayerName" --output text)
    for NAME in $LAYER_NAMES; do
        VERSION=$(aws lambda list-layer-versions --region "$R" --layer-name "$NAME" \
            --query "LayerVersions[0].Version" --output text)
        ARN=$(aws lambda get-layer-version --region "$R" --layer-name "$NAME" \
            --version-number "$VERSION" --query "LayerVersionArn" --output text)
        LOCATION=$(aws lambda get-layer-version --region "$R" --layer-name "$NAME" \
            --version-number "$VERSION" --query "Content.Location" --output text)
        MATCH=$(printf '%s' "$LOCATION" | grep -c "s3" || true)
        if [ "$MATCH" -gt 0 ]; then
            S3_ARNS="$S3_ARNS $ARN"
        fi
    done
done

S3_ARN=$(printf '%s\n' $S3_ARNS | grep . | head -n1)

printf 'Yes %s is using code hosted on S3.\n' "$S3_ARN" > "$OUT"
