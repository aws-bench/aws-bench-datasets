#!/bin/bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
POOL_ID="${IPAM_POOL_ID}"
OUT=/logs/agent/agent-output.txt

SCOPE_ARN=$(aws ec2 describe-ipam-pools --region "$REGION" \
  --filters "Name=ipam-pool-id,Values=${POOL_ID}" \
  --query 'IpamPools[0].IpamScopeArn' --output text)
SCOPE_ID="${SCOPE_ARN##*/}"

TARGET_POOL=$(aws ec2 create-ipam-pool --region "$REGION" \
  --ipam-scope-id "$SCOPE_ID" \
  --source-ipam-pool-id "$POOL_ID" \
  --locale "$REGION" \
  --address-family ipv4 \
  --description "regional pool for ${REGION} vpcs" \
  --query 'IpamPool.IpamPoolId' --output text)

for _ in $(seq 1 30); do
  st=$(aws ec2 describe-ipam-pools --region "$REGION" --filters "Name=ipam-pool-id,Values=${TARGET_POOL}" --query 'IpamPools[0].State' --output text)
  [ "$st" = "create-complete" ] && break
  sleep 5
done

aws ec2 provision-ipam-pool-cidr --region "$REGION" --ipam-pool-id "$TARGET_POOL" --netmask-length 16

for _ in $(seq 1 30); do
  st=$(aws ec2 get-ipam-pool-cidrs --region "$REGION" --ipam-pool-id "$TARGET_POOL" --query 'IpamPoolCidrs[0].State' --output text)
  [ "$st" = "provisioned" ] && break
  sleep 5
done

VPC_ID=$(aws ec2 create-vpc --region "$REGION" \
  --ipv4-ipam-pool-id "$TARGET_POOL" \
  --ipv4-netmask-length 24 \
  --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=ipam-managed-vpc}]' \
  --query 'Vpc.VpcId' --output text)

mkdir -p "$(dirname "$OUT")" && echo "Done." > "$OUT"
