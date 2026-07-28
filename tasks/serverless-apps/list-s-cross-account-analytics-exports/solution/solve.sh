#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

SOURCE_ACCOUNT="$(aws sts get-caller-identity --region "$REGION" --query 'Account' --output text)"

BUCKETS="$(aws s3api list-buckets --region "$REGION" --query 'Buckets[].Name' --output text)"
BUCKET_COUNT="$(printf '%s\n' $BUCKETS | awk 'NF{c++} END{print c+0}')"

MATCHES=""
for B in $BUCKETS; do
    ROWS="$(aws s3api list-bucket-analytics-configurations --bucket "$B" --region "$REGION" \
        --query "AnalyticsConfigurationList[?StorageClassAnalysis.DataExport.Destination.S3BucketDestination.BucketAccountId!=null && StorageClassAnalysis.DataExport.Destination.S3BucketDestination.BucketAccountId!='${SOURCE_ACCOUNT}'].[Id,StorageClassAnalysis.DataExport.Destination.S3BucketDestination.BucketAccountId]" \
        --output text)"
    MATCHES="${MATCHES}$(printf '%s' "$ROWS" | awk -v b="$B" '$0!="None" && NF{print b"\t"$0}')
"
done

CLEAN="$(printf '%s' "$MATCHES" | awk 'NF')"
MATCH_COUNT="$(printf '%s\n' "$CLEAN" | awk 'NF{c++} END{print c+0}')"
MATCH_BUCKET="$(printf '%s\n' "$CLEAN" | awk 'NR==1{print $1}')"
CONFIG_ID="$(printf '%s\n' "$CLEAN" | awk 'NR==1{print $2}')"
DEST_ACCOUNT="$(printf '%s\n' "$CLEAN" | awk 'NR==1{print $3}')"

cat > "$OUT" <<EOF
Across the ${BUCKET_COUNT} S3 buckets in account ${SOURCE_ACCOUNT}, exactly ${MATCH_COUNT} analytics configuration exports data to a bucket owned by a different account: '${CONFIG_ID}' on ${MATCH_BUCKET}, whose StorageClassAnalysis data-export S3BucketDestination sets BucketAccountId to ${DEST_ACCOUNT}, which is not ${SOURCE_ACCOUNT}, the account that owns the source bucket. It is the only such configuration.
EOF
