#!/bin/bash
set -euo pipefail

export AWS_DEFAULT_REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

REGIONS=$(aws ec2 describe-regions --query "Regions[].RegionName" --output text)

{
    echo "EC2 instance ids across all regions:"
    for r in $REGIONS; do
        IDS=$(aws ec2 describe-instances --region "$r" \
            --filters "Name=instance-state-name,Values=pending,running,stopping,stopped" \
            --query "Reservations[].Instances[].InstanceId" --output text 2>/dev/null) || continue
        if [ -n "$IDS" ]; then
            echo "In region ${r} you have the instance(s): $(echo "$IDS" | tr '\t' ' ')."
        fi
    done
} > "$OUT"
