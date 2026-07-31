#!/bin/bash
set -euo pipefail

OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

ALLOWED_REGIONS="${ALLOWED_REGIONS}"
REGIONS=$(echo "$ALLOWED_REGIONS" | tr ',' ' ')

DATA=""
for region in $REGIONS; do
    region=$(echo "$region" | tr -d '[:space:]')
    ROWS=$(aws ec2 describe-instances --region "$region" \
        --filters "Name=instance-state-name,Values=pending,running,stopping,stopped" \
        --query "Reservations[].Instances[].[VpcId,InstanceId]" --output text)
    while read -r vpc iid; do
        [ -z "$iid" ] && continue
        DATA="${DATA}${region} ${vpc} ${iid}"$'\n'
    done <<< "$ROWS"
done

TOTAL=$(printf '%s' "$DATA" | grep -c .)
REGION_COUNT=$(printf '%s' "$DATA" | awk '{print $1}' | sort -u | grep -c .)
VPC_COUNT=$(printf '%s' "$DATA" | awk '{print $2}' | sort -u | grep -c .)

{
    echo "There are ${TOTAL} EC2 instances across ${REGION_COUNT} regions and ${VPC_COUNT} VPCs."
    echo
    for region in $REGIONS; do
        region=$(echo "$region" | tr -d '[:space:]')
        REGION_ROWS=$(printf '%s' "$DATA" | awk -v r="$region" '$1==r')
        [ -z "$REGION_ROWS" ] && continue
        VPCS=$(printf '%s' "$REGION_ROWS" | awk '{print $2}' | sort | uniq -c | sort -rn | awk '{print $2}')
        echo "In region ${region}:"
        for vpc in $VPCS; do
            IIDS=$(printf '%s' "$REGION_ROWS" | awk -v v="$vpc" '$2==v {print $3}' | tr '\n' ',' | sed 's/,$//; s/,/, /g')
            VCOUNT=$(printf '%s' "$REGION_ROWS" | awk -v v="$vpc" '$2==v' | grep -c .)
            echo "  VPC ${vpc} contains ${VCOUNT} instance(s): ${IIDS}"
        done
    done
} > "$OUT"
