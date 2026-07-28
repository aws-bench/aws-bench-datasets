#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

BUCKETS=$(aws s3api list-buckets --region "$REGION" --query "Buckets[].Name" --output text)

BUCKET=""
CONFIG_ID=""
for b in $BUCKETS; do
    ID=$(aws s3api list-bucket-inventory-configurations --bucket "$b" --region "$REGION" \
        --query "InventoryConfigurationList[?Destination.S3BucketDestination.Prefix==null].Id | [0]" --output text)
    if [ "$ID" != "None" ]; then
        BUCKET="$b"
        CONFIG_ID="$ID"
        break
    fi
done

FILTER_PREFIX=$(aws s3api list-bucket-inventory-configurations --bucket "$BUCKET" --region "$REGION" \
    --query "InventoryConfigurationList[?Id=='${CONFIG_ID}'].Filter.Prefix | [0]" --output text)
DEST_ARN=$(aws s3api list-bucket-inventory-configurations --bucket "$BUCKET" --region "$REGION" \
    --query "InventoryConfigurationList[?Id=='${CONFIG_ID}'].Destination.S3BucketDestination.Bucket | [0]" --output text)
DEST_BUCKET=${DEST_ARN##*:::}

cat > "$OUT" <<EOF
Yes. Your '${CONFIG_ID}' inventory configuration on bucket ${BUCKET} has no Destination.S3BucketDestination.Prefix, so its reports land at the root of its destination bucket (${DEST_BUCKET}) rather than under a prefix. The '${FILTER_PREFIX}' prefix on this configuration is the source-side Filter.Prefix (which objects get inventoried), not a destination prefix.
EOF
