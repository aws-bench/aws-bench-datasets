#!/bin/bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
CLUSTER="${EXPECTED_CLUSTER}"
BUCKETS_CSV="${EXPECTED_BUCKETS_CSV}"
OUT=/logs/agent/agent-output.txt

for addon in cert-manager amazon-sagemaker-hyperpod-training-operator; do
  aws eks create-addon --cluster-name "$CLUSTER" --addon-name "$addon" \
    --resolve-conflicts OVERWRITE --region "$REGION"
done

IFS=',' read -ra BUCKETS <<< "$BUCKETS_CSV"
for b in "${BUCKETS[@]}"; do
  b="$(echo "$b" | xargs)"
  while true; do
    objects="$(aws s3api list-object-versions --bucket "$b" --region "$REGION" \
      --output json --query '{Objects: [Versions,DeleteMarkers][][].{Key:Key,VersionId:VersionId}}')"
    count="$(echo "$objects" | jq '.Objects | length // 0')"
    [ "$count" -eq 0 ] && break
    aws s3api delete-objects --bucket "$b" --region "$REGION" \
      --delete "$(echo "$objects" | jq -c '. + {Quiet: true}')"
  done
done

mkdir -p "$(dirname "$OUT")" && echo "Done." > "$OUT"
