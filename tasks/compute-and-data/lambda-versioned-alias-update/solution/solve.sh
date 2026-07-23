#!/bin/bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
FUNCTION="${EXPECTED_FUNCTION}"
NEW_TABLE="${EXPECTED_NEW_TABLE}"
OUT=/logs/agent/agent-output.txt

aws lambda update-function-configuration --function-name "$FUNCTION" --region "$REGION" \
  --environment "{\"Variables\":{\"OLD_TABLE_NAME\":\"${NEW_TABLE}\"}}"

mkdir -p "$(dirname "$OUT")" && echo "Done." > "$OUT"
