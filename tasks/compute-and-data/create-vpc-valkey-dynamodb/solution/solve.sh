#!/bin/bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
VPC_NAME="${VPC_NAME:-storage-app-vpc}"
SUBNET_GROUP="${SUBNET_GROUP:-storage-app-subnet-group}"
REPLICATION_GROUP_ID="${REPLICATION_GROUP_ID:-storage-app-valkey}"
TABLE_NAME="${TABLE_NAME:-storage-app-table}"
OUT=/logs/agent/agent-output.txt
OUT_JSON=/logs/agent/agent-output.json

VPC_ID="$(aws ec2 create-vpc --region "$REGION" --cidr-block 10.0.0.0/16 --tag-specifications "ResourceType=vpc,Tags=[{Key=Name,Value=${VPC_NAME}}]" --query 'Vpc.VpcId' --output text)"
aws ec2 wait vpc-available --region "$REGION" --vpc-ids "$VPC_ID"

read -r -a AZS <<< "$(aws ec2 describe-availability-zones --region "$REGION" --filters "Name=state,Values=available" --query 'AvailabilityZones[0:2].ZoneName' --output text)"

SUBNET_IDS=()
i=1
for AZ in "${AZS[@]}"; do
  SN="$(aws ec2 create-subnet --region "$REGION" --vpc-id "$VPC_ID" --cidr-block "10.0.${i}.0/24" --availability-zone "$AZ" --query 'Subnet.SubnetId' --output text)"
  SUBNET_IDS+=("$SN")
  i=$((i + 1))
done

aws elasticache create-cache-subnet-group --region "$REGION" --cache-subnet-group-name "$SUBNET_GROUP" --cache-subnet-group-description "storage app subnet group" --subnet-ids "${SUBNET_IDS[@]}"

aws elasticache create-replication-group --region "$REGION" \
  --replication-group-id "$REPLICATION_GROUP_ID" \
  --replication-group-description "Valkey cluster for storage application" \
  --engine valkey --engine-version 8.0 \
  --cache-node-type cache.t3.micro --num-cache-clusters 1 \
  --cache-subnet-group-name "$SUBNET_GROUP" \
  --transit-encryption-enabled

aws dynamodb create-table --region "$REGION" \
  --table-name "$TABLE_NAME" \
  --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST

mkdir -p "$(dirname "$OUT")"
printf '{"VpcId": "%s", "ReplicationGroupId": "%s", "DynamoTableName": "%s"}\n' "$VPC_ID" "$REPLICATION_GROUP_ID" "$TABLE_NAME" > "$OUT_JSON"
echo "Done." > "$OUT"
