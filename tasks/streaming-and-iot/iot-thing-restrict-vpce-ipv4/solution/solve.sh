#!/bin/bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
THING="${THING_NAME}"
POLICY_NAME="${POLICY_NAME:-${THING}-vpce-restrict}"
OUT=/logs/agent/agent-output.json

POLICY_DOC=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowDataPlaneViaVPCE",
      "Effect": "Allow",
      "Action": ["iot:Connect", "iot:Publish", "iot:Subscribe", "iot:Receive"],
      "Resource": "*",
      "Condition": {"StringEquals": {"aws:SourceVpce": "${VPCE_ID}"}}
    }
  ]
}
EOF
)

aws iot create-policy --region "$REGION" --policy-name "$POLICY_NAME" --policy-document "$POLICY_DOC"

CERT_ARN=$(aws iot create-keys-and-certificate --region "$REGION" --set-as-active --query 'certificateArn' --output text)

aws iot attach-policy --region "$REGION" --policy-name "$POLICY_NAME" --target "$CERT_ARN"

aws iot attach-thing-principal --region "$REGION" --thing-name "$THING" --principal "$CERT_ARN"

mkdir -p "$(dirname "$OUT")"
printf '{"policy_name": "%s"}\n' "$POLICY_NAME" > "$OUT"
echo "Done." > /logs/agent/agent-output.txt
