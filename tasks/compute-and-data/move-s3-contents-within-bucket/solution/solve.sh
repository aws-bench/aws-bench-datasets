#!/bin/bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
BUCKET="${BUCKET_NAME}"
DEST="${DESTINATION_PATH:-destination/}"
OUT=/logs/agent/agent-output.txt

aws s3 mv "s3://${BUCKET}/source/" "s3://${BUCKET}/${DEST}" --recursive --region "$REGION"
mkdir -p "$(dirname "$OUT")" && echo "Done." > "$OUT"
