#!/bin/bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
SRC="${SYNC_SOURCE_BUCKET}"
DST="${DESTINATION_BUCKET}"
OUT=/logs/agent/agent-output.txt

aws s3 cp "s3://${SRC}/" "s3://${DST}/" --recursive \
  --metadata-directive REPLACE --metadata migrated=true \
  --acl bucket-owner-full-control --region "$REGION"

mkdir -p "$(dirname "$OUT")" && echo "Done." > "$OUT"
