#!/bin/bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
OUT=/logs/agent/agent-output.txt

aws customer-profiles create-profile --domain-name "$DOMAIN_NAME" --account-number "$ACCOUNT_ID_1" --region "$REGION"
aws customer-profiles create-profile --domain-name "$DOMAIN_NAME" --account-number "$ACCOUNT_ID_2" --region "$REGION"

mkdir -p "$(dirname "$OUT")" && echo "Done." > "$OUT"
