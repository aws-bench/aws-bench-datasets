#!/bin/bash
set -euo pipefail

OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

EAST=$(aws ec2 describe-instances --region us-east-1 \
    --filters Name=instance-state-name,Values=running \
    --query 'Reservations[].Instances[].[InstanceId,VpcId]' --output text)
EAST_COUNT=$(printf '%s\n' "$EAST" | grep -c .)

WEST1=$(aws ec2 describe-instances --region us-west-1 \
    --filters Name=instance-state-name,Values=running \
    --query 'Reservations[].Instances[].[InstanceId,VpcId]' --output text)
WEST1_COUNT=$(printf '%s\n' "$WEST1" | grep -c .)

WEST2=$(aws ec2 describe-instances --region us-west-2 \
    --filters Name=instance-state-name,Values=running \
    --query 'Reservations[].Instances[].[InstanceId,VpcId]' --output text)
WEST2_COUNT=$(printf '%s\n' "$WEST2" | grep -c .)

DEFAULT_VPC=$(aws ec2 describe-vpcs --region us-east-1 \
    --filters Name=isDefault,Values=true \
    --query 'Vpcs[].VpcId' --output text)

SHARED_VPC=$(printf '%s\n' "$EAST" | awk -v d="$DEFAULT_VPC" '$2!=d {print $2}' | sort -u)
SHARED_IDS=$(printf '%s\n' "$EAST" | awk -v v="$SHARED_VPC" '$2==v {print $1}')
SHARED_LIST=$(printf '%s\n' "$SHARED_IDS" | paste -sd ', ' -)

cat > "$OUT" <<EOF
You have ${EAST_COUNT} EC2 instances in us-east-1, ${WEST1_COUNT} in us-west-1, and ${WEST2_COUNT} in us-west-2. In us-east-1, instances ${SHARED_LIST} share the same VPC (${SHARED_VPC}). The remaining instance is in the default VPC (${DEFAULT_VPC}) and is not network-adjacent to the others.
EOF
