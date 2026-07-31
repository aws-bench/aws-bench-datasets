#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

BUCKETS=$(aws s3api list-buckets --region "$REGION" --query "Buckets[].Name" --output text)

MATCHES=""
for bucket in $BUCKETS; do
    TAGGED=$(aws s3api list-bucket-metrics-configurations --region "$REGION" --bucket "$bucket" \
        --query "MetricsConfigurationList[?Filter.Tag || Filter.And.Tags] | [0].Id" --output text)
    [ "$TAGGED" != "None" ] && MATCHES="$MATCHES $bucket"
done
MATCHES="${MATCHES# }"

: > "$OUT"
for b in $MATCHES; do
    printf 'You have the bucket %s which uses tag filters.\n' "$b" >> "$OUT"
done
