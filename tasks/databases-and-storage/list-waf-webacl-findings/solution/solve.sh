#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

read -r ACL_NAME ACL_ID ACL_ARN < <(aws wafv2 list-web-acls --scope REGIONAL --region "$REGION" \
    --query "WebACLs[0].[Name,Id,ARN]" --output text)

DETAILS=$(aws wafv2 get-web-acl --scope REGIONAL --region "$REGION" --name "$ACL_NAME" --id "$ACL_ID")

DEFAULT_ACTION=$(echo "$DETAILS" | jq -r '.WebACL.DefaultAction | keys[0] | ascii_downcase')
RULE_NAME=$(echo "$DETAILS" | jq -r '.WebACL.Rules[0].Name')
RULE_PRIORITY=$(echo "$DETAILS" | jq -r '.WebACL.Rules[0].Priority')
RATE_LIMIT=$(echo "$DETAILS" | jq -r '.WebACL.Rules[0].Statement.RateBasedStatement.Limit')

cat > "$OUT" <<EOF
The WebACL has a default action set to ${DEFAULT_ACTION} with a rate-limiting rule named ${RULE_NAME} with a priority of ${RULE_PRIORITY}, which blocks IP addresses exceeding ${RATE_LIMIT} requests. The Web ACL ID is ${ACL_ID} and the Web ACL ARN is ${ACL_ARN}.
EOF
