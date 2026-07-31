#!/bin/bash
set -euo pipefail

REGION="us-east-1"
BUCKET="${TENANT_SERVICES_BUCKET_NAME}"
DISTRIBUTION_ID="${DISTRIBUTION_ID}"
OAC_ID="${OAC_ID}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

BUCKET_POLICY="$(aws s3api get-bucket-policy --region "$REGION" --bucket "$BUCKET" --query Policy --output text)"

CONNECTION_MODE="$(aws cloudfront get-distribution --id "$DISTRIBUTION_ID" \
    --query 'Distribution.DistributionConfig.ConnectionMode' --output text)"

TENANT_COUNT="$(aws cloudfront list-distribution-tenants \
    --association-filter DistributionId="$DISTRIBUTION_ID" \
    --query 'length(DistributionTenantList)' --output text)"

OAC_SIGNING="$(aws cloudfront get-origin-access-control --id "$OAC_ID" \
    --query 'OriginAccessControl.OriginAccessControlConfig.[SigningBehavior,SigningProtocol]' \
    --output text)"
SIGNING_BEHAVIOR="$(printf '%s' "$OAC_SIGNING" | awk '{print $1}')"
SIGNING_PROTOCOL="$(printf '%s' "$OAC_SIGNING" | awk '{print $2}')"

cat > "$OUT" <<EOF
CloudFront distribution $DISTRIBUTION_ID returns 403 for all tenant requests because of two distinct issues.

1. The S3 bucket policy on $BUCKET does not grant the CloudFront OAC access (primary root cause).
   The only statement present is a Deny for non-SSL traffic (aws:SecureTransport = false); there is no
   Allow statement for the cloudfront.amazonaws.com service principal on s3:GetObject conditioned on the
   distribution ARN (AWS:SourceArn). OAC $OAC_ID is attached and signs every origin request
   (signing_behavior=$SIGNING_BEHAVIOR, signing_protocol=$SIGNING_PROTOCOL), but S3 rejects those signed
   requests with 403 because no bucket policy statement permits them. Current bucket policy:
$BUCKET_POLICY

2. The distribution is in connection_mode=$CONNECTION_MODE (tenant-only) but has $TENANT_COUNT distribution
   tenants created. With no tenant configuration there is nothing to resolve the TenantPath parameter and
   route requests through, so tenant requests cannot be served.

The missing bucket policy OAC grant is the primary issue: even after distribution tenants are created,
requests would still fail with 403 until the bucket policy grants cloudfront.amazonaws.com access to
$BUCKET scoped to the distribution ARN.
EOF
