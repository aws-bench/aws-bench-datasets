#!/bin/bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
TABLE="${EXPECTED_TABLE}"
OUT=/logs/agent/agent-output.txt

for RID in PROD-EC2-015 PROD-EC2-027 PROD-EC2-041 PROD-EC2-063 PROD-EC2-078 PROD-EC2-084 PROD-EC2-091; do
  aws dynamodb update-item \
    --table-name "$TABLE" \
    --key "{\"id\":{\"S\":\"${RID}\"}}" \
    --update-expression "REMOVE ec2_instance_id, ec2_instance_type" \
    --region "$REGION"
done

mkdir -p "$(dirname "$OUT")" && echo "Done." > "$OUT"
