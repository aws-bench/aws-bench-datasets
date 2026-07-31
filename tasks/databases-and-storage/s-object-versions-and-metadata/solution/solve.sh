#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

VERSIONS="$(aws s3api list-object-versions --bucket "$BUCKET_NAME" --region "$REGION" --query 'Versions[?IsLatest]' --output json)"

MR_KEY="$(printf '%s' "$VERSIONS" | jq -r 'sort_by(.LastModified) | last | .Key')"
MR_VID="$(printf '%s' "$VERSIONS" | jq -r 'sort_by(.LastModified) | last | .VersionId')"

PROD_SIZE="$(printf '%s' "$VERSIONS" | jq -r '.[] | select(.Key=="prod_data.txt") | .Size')"
PROD_VID="$(printf '%s' "$VERSIONS" | jq -r '.[] | select(.Key=="prod_data.txt") | .VersionId')"

cat > "$OUT" <<EOF
The most recently modified object is \`${MR_KEY}\` with version ID \`${MR_VID}\`. The object \`prod_data.txt\` has version ID \`${PROD_VID}\` and is ${PROD_SIZE} bytes.
EOF
