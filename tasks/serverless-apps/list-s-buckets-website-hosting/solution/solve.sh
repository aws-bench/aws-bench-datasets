#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

BUCKETS=$(aws s3api list-buckets --region "$REGION" --query "Buckets[].Name" --output text)

WEBSITE_BUCKETS=""
for b in $BUCKETS; do
    if aws s3api get-bucket-website --region "$REGION" --bucket "$b" >/dev/null 2>&1; then
        WEBSITE_BUCKETS="${WEBSITE_BUCKETS}${b}\n"
    fi
done

NAMES=$(printf '%b' "$WEBSITE_BUCKETS" | grep -c .)
NAME=$(printf '%b' "$WEBSITE_BUCKETS" | grep .)

printf '%s S3 bucket(s) in your account have website hosting enabled: %s/ %s\n' "$NAMES" "$NAMES" "$NAME" > "$OUT"
