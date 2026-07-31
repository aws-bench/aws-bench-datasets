#!/bin/bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="${APPSTREAM_STACK_NAME:-appstream-streaming-vpce-stack}"
ROLE_NAME="${APPSTREAM_ROLE_NAME:-AmazonAppStreamServiceAccess}"
OUT=/logs/agent/agent-output.txt
OUT_JSON=/logs/agent/agent-output.json

VPC_ID="$(aws ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)"

SUBNET_ID="$(aws ec2 describe-subnets --region "$REGION" --filters Name=vpc-id,Values="$VPC_ID" --query 'Subnets[0].SubnetId' --output text)"
SG_ID="$(aws ec2 describe-security-groups --region "$REGION" --filters Name=vpc-id,Values="$VPC_ID" Name=group-name,Values=default --query 'SecurityGroups[0].GroupId' --output text)"

SERVICE_NAME="com.amazonaws.${REGION}.appstream.streaming"
VPCE_ID="$(aws ec2 create-vpc-endpoint --region "$REGION" --vpc-id "$VPC_ID" --service-name "$SERVICE_NAME" --vpc-endpoint-type Interface --subnet-ids "$SUBNET_ID" --security-group-ids "$SG_ID" --query 'VpcEndpoint.VpcEndpointId' --output text)"

aws iam create-role --path /service-role/ --role-name "$ROLE_NAME" --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"appstream.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/service-role/AmazonAppStreamServiceAccess

for _ in $(seq 1 12); do
  if aws appstream create-stack --region "$REGION" --name "$STACK_NAME" --description "AppStream 2.0 stack with STREAMING VPC endpoint" --access-endpoints "EndpointType=STREAMING,VpceId=${VPCE_ID}"; then
    break
  fi
  sleep 10
done

mkdir -p "$(dirname "$OUT")"
printf '{"appstream_stack_name": "%s", "vpc_endpoint_id": "%s"}\n' "$STACK_NAME" "$VPCE_ID" > "$OUT_JSON"
echo "Done." > "$OUT"
