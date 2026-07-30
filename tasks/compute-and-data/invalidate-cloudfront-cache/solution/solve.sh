#!/bin/bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
DIST="${DISTRIBUTION_ID}"
OUT=/logs/agent/agent-output.txt
OUT_JSON=/logs/agent/agent-output.json

INV_ID=$(aws cloudfront create-invalidation \
  --distribution-id "$DIST" \
  --paths "/*" \
  --region "$REGION" \
  --query "Invalidation.Id" --output text)

mkdir -p "$(dirname "$OUT")"
printf '{\n  "InvalidationID": "%s"\n}\n' "$INV_ID" > "$OUT_JSON"
echo "Done." > "$OUT"
