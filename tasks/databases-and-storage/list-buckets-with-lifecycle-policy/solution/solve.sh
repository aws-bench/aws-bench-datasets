#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

CANDIDATES=$(aws s3api list-buckets --region "$REGION" \
    --query "Buckets[?!contains(Name,'cdk-') && !contains(Name,'cloudtrail') && !starts_with(Name,'deployments') && !starts_with(Name,'do-not-delete-')].Name" \
    --output text)

MATCHES=""
for BUCKET in $CANDIDATES; do
    if aws s3api get-bucket-lifecycle-configuration --bucket "$BUCKET" --region "$REGION" >/dev/null 2>&1; then
        MATCHES="${MATCHES}${MATCHES:+ }${BUCKET}"
    fi
done

echo "You have one S3 bucket with lifecycle policy set named ${MATCHES}." > "$OUT"
