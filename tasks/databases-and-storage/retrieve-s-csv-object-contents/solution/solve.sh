#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

CONTENTS="$(aws s3 cp "s3://${BUCKET_NAME}/${OBJECT_NAME}" - --region "$REGION")"

printf 'Successfully retrieved the contents of the CSV object file %s that is available in S3 bucket %s:\n\n%s\n' \
    "$OBJECT_NAME" "$BUCKET_NAME" "$CONTENTS" > "$OUT"
