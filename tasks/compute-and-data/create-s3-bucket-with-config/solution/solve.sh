#!/bin/bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
BUCKET="${BUCKET_NAME:-ai-testing-bucket-$(date +%s)-$RANDOM}"
OUT=/logs/agent/agent-output.txt
OUT_JSON=/logs/agent/agent-output.json

aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"

aws s3api put-public-access-block --bucket "$BUCKET" --region "$REGION" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws s3api put-bucket-encryption --bucket "$BUCKET" --region "$REGION" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws s3api put-bucket-versioning --bucket "$BUCKET" --region "$REGION" \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-tagging --bucket "$BUCKET" --region "$REGION" \
  --tagging 'TagSet=[{Key=Environment,Value=Testing},{Key=Purpose,Value=AIOperations},{Key=Owner,Value=AITeam},{Key=Project,Value=AITesting}]'

mkdir -p "$(dirname "$OUT")"
echo "Done." > "$OUT"
printf '{"S3BucketName": "%s"}\n' "$BUCKET" > "$OUT_JSON"
