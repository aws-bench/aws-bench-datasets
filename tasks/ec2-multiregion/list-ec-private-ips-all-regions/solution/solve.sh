#!/bin/bash
set -euo pipefail

OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

ALLOWED_REGIONS="${ALLOWED_REGIONS}"
REGIONS=$(echo "$ALLOWED_REGIONS" | tr ',' ' ')
export AWS_DEFAULT_REGION=$(echo "$REGIONS" | awk '{print $1}')

{
    echo "| Region      | Instance ID          | Private IP    |"
    echo "|-------------|----------------------|---------------|"
    for region in $REGIONS; do
        ROWS=$(aws ec2 describe-instances --region "$region" \
            --filters "Name=instance-state-name,Values=pending,running,stopping,stopped" \
            --query "Reservations[].Instances[].[InstanceId,PrivateIpAddress]" \
            --output text)
        printf '%s\n' "$ROWS" | grep -v '^$' | while read -r id ip; do
            printf '| %s   | %s | %s    |\n' "$region" "$id" "$ip"
        done
    done
} > "$OUT"
