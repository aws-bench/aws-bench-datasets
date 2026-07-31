#!/bin/bash
set -euo pipefail

OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

INVENTORY=""
for bucket in $(aws s3api list-buckets --query 'Buckets[].Name' --output text); do
    loc=$(aws s3api get-bucket-location --bucket "$bucket" --query 'LocationConstraint' --output text)
    loc=${loc/None/us-east-1}
    loc=${loc/null/us-east-1}
    enc=$(aws s3api get-bucket-encryption --bucket "$bucket" --region "$loc" \
        --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.[SSEAlgorithm,KMSMasterKeyID]' \
        --output text)
    alg=$(printf '%s' "$enc" | awk '{print $1}')
    keyid=$(printf '%s' "$enc" | awk '{print $2}')
    INVENTORY="${INVENTORY}${bucket}|${alg}|${keyid}"$'\n'
done

KMS=$(printf '%s' "$INVENTORY" | awk -F'|' '$2=="aws:kms"')
AES=$(printf '%s' "$INVENTORY" | awk -F'|' '$2!="aws:kms" && $2!=""')

PROD_LINE=$(printf '%s' "$KMS" | awk -F'|' '$1 !~ /^cdk-/ {print; exit}')
PROD=$(printf '%s' "$PROD_LINE" | cut -d'|' -f1)
PROD_KEY=$(printf '%s' "$PROD_LINE" | cut -d'|' -f3)
CDK=$(printf '%s' "$KMS" | awk -F'|' '$1 ~ /^cdk-/ {print $1}' | tr '\n' ',' | sed 's/,$//; s/,/, /g')

KEYNOTE="no KMSMasterKeyID is set, i.e. the AWS-managed key (aws/s3), not a customer-managed key"
case "$PROD_KEY" in
    None|"") ;;
    *) KEYNOTE="KMSMasterKeyID=${PROD_KEY}" ;;
esac

cat > "$OUT" <<EOF
The bucket ${PROD} uses AWS KMS encryption (SSE-KMS, SSEAlgorithm=aws:kms). In its default-encryption rule ${KEYNOTE}.

The CDK infrastructure staging buckets also use KMS encryption: ${CDK}.

All other buckets use the default S3-managed encryption (SSE-S3/AES256):
$(printf '%s' "$AES" | cut -d'|' -f1 | sed 's/^/- /')
EOF
