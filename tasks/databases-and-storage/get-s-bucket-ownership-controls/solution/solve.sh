#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

BUCKET1="${EMPTY_S3_BUCKET1}"
BUCKET2="${EMPTY_S3_BUCKET2}"
BUCKET3="${S3_BUCKET_WITH_LIFECYCLE_RULES}"

OWN1=$(aws s3api get-bucket-ownership-controls --region "$REGION" --bucket "$BUCKET1" \
    --query 'OwnershipControls.Rules[0].ObjectOwnership' --output text)
OWN2=$(aws s3api get-bucket-ownership-controls --region "$REGION" --bucket "$BUCKET2" \
    --query 'OwnershipControls.Rules[0].ObjectOwnership' --output text)
OWN3=$(aws s3api get-bucket-ownership-controls --region "$REGION" --bucket "$BUCKET3" \
    --query 'OwnershipControls.Rules[0].ObjectOwnership' --output text)

cat > "$OUT" <<EOF
The object ownership for ${BUCKET1} is ${OWN1} and for ${BUCKET2} is ${OWN2} and for ${BUCKET3} is ${OWN3}.
EOF
