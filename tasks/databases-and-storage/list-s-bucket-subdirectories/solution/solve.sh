#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

SUBDIR=$(aws s3api list-objects-v2 --bucket "$BUCKET_NAME" --delimiter / --region "$REGION" \
    --query "CommonPrefixes[].Prefix" --output text)

echo "Successfully retrieved the only sub directory ${SUBDIR} available in the S3 bucket ${BUCKET_NAME}." > "$OUT"
