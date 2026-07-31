#!/bin/bash
set -euo pipefail

OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

REGIONS=$(aws ec2 describe-regions --region us-east-1 \
    --query "Regions[].RegionName" --output text)

BODY=""
for r in $REGIONS; do
    DEFAULT_VPC=""
    if DEFAULT_VPC=$(aws ec2 describe-vpcs --region "$r" \
        --filters Name=isDefault,Values=true \
        --query "Vpcs[0].VpcId" --output text 2>/dev/null); then
        INSTANCES=$(aws ec2 describe-instances --region "$r" \
            --filters Name=instance-state-name,Values=pending,running,stopping,stopped \
            --query "Reservations[].Instances[?VpcId!='${DEFAULT_VPC}'].InstanceId" \
            --output text)
        IDS=$(printf '%s\n' $INSTANCES | tr '\n' ' ' | sed 's/ *$//;s/  */, /g')
        if [ -n "$IDS" ]; then
            BODY="${BODY}- ${IDS} in ${r}\n"
        fi
    fi
done

{
    echo "The following EC2 instances are not associated with a default VPC (they run in non-default VPCs):"
    echo
    printf "%b" "$BODY"
} > "$OUT"
