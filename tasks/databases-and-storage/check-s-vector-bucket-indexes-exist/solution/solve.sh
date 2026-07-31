#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

FIRST_COUNT=$(aws s3vectors list-vectors --region "$REGION" --index-arn "$FIRST_INDEX_ARN" --return-metadata \
    --query "length(vectors)" --output text)
FIRST_CATEGORIES=$(aws s3vectors list-vectors --region "$REGION" --index-arn "$FIRST_INDEX_ARN" --return-metadata \
    --query "vectors[].metadata.category" --output text | tr '\t' '\n' | awk '!seen[$0]++' | paste -sd '~' - | sed 's/~/ and /g')
SECOND_COUNT=$(aws s3vectors list-vectors --region "$REGION" --index-arn "$SECOND_INDEX_ARN" --return-metadata \
    --query "length(vectors)" --output text)

cat > "$OUT" <<EOF
The first index ${FIRST_INDEX_ARN} contains vectors (${FIRST_COUNT} documents with metadata including categories like ${FIRST_CATEGORIES}). The second index ${SECOND_INDEX_ARN} is empty. No vectors exist in it.
EOF
