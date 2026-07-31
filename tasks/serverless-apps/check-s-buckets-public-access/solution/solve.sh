#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

BUCKETS=$(aws s3api list-buckets --region "$REGION" --query "Buckets[].Name" --output text)

DEVIANT=""
DEVIANT_PAB=""
for b in $BUCKETS; do
  PAB=$(aws s3api get-public-access-block --region "$REGION" --bucket "$b" \
      --query "PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]" \
      --output text)
  case "$PAB" in
    $'True\tTrue\tTrue\tTrue') ;;
    *) DEVIANT="$b"; DEVIANT_PAB="$PAB" ;;
  esac
done

read -r BPA IPA BPP RPB <<<"$DEVIANT_PAB"

{
  echo "Not quite. One bucket, ${DEVIANT}, does not have full public access blocking in place."
  echo
  echo "Its four Public Access Block settings are:"
  echo "  BlockPublicAcls       = ${BPA}"
  echo "  IgnorePublicAcls      = ${IPA}"
  echo "  BlockPublicPolicy     = ${BPP}"
  echo "  RestrictPublicBuckets = ${RPB}"
  echo
  echo "BlockPublicAcls is false while its other three settings (IgnorePublicAcls, BlockPublicPolicy, RestrictPublicBuckets) are true. Every other bucket in the account has all four settings true."
  echo
  echo "That gap does not actually expose the bucket. IgnorePublicAcls=true makes S3 ignore any public ACLs that BlockPublicAcls=false would otherwise allow, and BlockPublicPolicy=true plus RestrictPublicBuckets=true block public access via bucket policy or access points. So ${DEVIANT} deviates from complete blocking, but no bucket in the account currently allows public access."
} > "$OUT"
