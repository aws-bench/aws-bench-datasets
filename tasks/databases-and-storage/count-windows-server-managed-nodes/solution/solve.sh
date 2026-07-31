#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

COUNT=$(aws ssm describe-instance-information --region "$REGION" \
    --query "length(InstanceInformationList[?PlatformType=='Windows' && contains(PlatformName, '2022')])" \
    --output text)

echo "You have ${COUNT} Windows Server 2022 managed node in ${REGION}." > "$OUT"
