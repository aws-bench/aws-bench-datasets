#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

OBJ1=$(aws s3api list-objects-v2 --bucket "$BUCKET1_NAME" --region "$REGION" \
    --query "Contents[].[Key,Size,ETag]" --output text)
OBJ2=$(aws s3api list-objects-v2 --bucket "$BUCKET2_NAME" --region "$REGION" \
    --query "Contents[].[Key,Size,ETag]" --output text)

KEY1=$(printf '%s\n' "$OBJ1" | awk 'NR==1{print $1}')
SIZE1=$(printf '%s\n' "$OBJ1" | awk 'NR==1{print $2}')
ETAG1=$(printf '%s\n' "$OBJ1" | awk 'NR==1{print $3}')
KEY2=$(printf '%s\n' "$OBJ2" | awk 'NR==1{print $1}')
SIZE2=$(printf '%s\n' "$OBJ2" | awk 'NR==1{print $2}')
ETAG2=$(printf '%s\n' "$OBJ2" | awk 'NR==1{print $3}')

DIR1="${KEY1%/*}/"
DIR2="${KEY2%/*}/"

CONTENT="different"
if [ "$ETAG1" = "$ETAG2" ] && [ "$SIZE1" = "$SIZE2" ]; then CONTENT="identical"; fi

cat > "$OUT" <<EOF
The S3 buckets $BUCKET1_NAME and $BUCKET2_NAME contain different folder structures: $DIR1 and $DIR2 respectively, both having $CONTENT file content and size of $SIZE1 bytes.
EOF
