#!/bin/bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-ap-southeast-1}"
SERVICE_ROLE="EMR_DefaultRole"
EC2_ROLE="EMR_EC2_DefaultRole"
OUT=/logs/agent/agent-output.txt
OUT_JSON=/logs/agent/agent-output.json

aws iam create-role --role-name "$SERVICE_ROLE" \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"elasticmapreduce.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name "$SERVICE_ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AmazonElasticMapReduceRole
aws iam attach-role-policy --role-name "$SERVICE_ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonElasticMapReducePlacementGroupPolicy

aws iam create-role --role-name "$EC2_ROLE" \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name "$EC2_ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AmazonElasticMapReduceforEC2Role
aws iam create-instance-profile --instance-profile-name "$EC2_ROLE"
aws iam add-role-to-instance-profile --instance-profile-name "$EC2_ROLE" --role-name "$EC2_ROLE"

SUBNET_ID=$(aws ec2 describe-subnets --region "$REGION" \
  --filters "Name=state,Values=available" \
  --query 'Subnets[0].SubnetId' --output text)

sleep 30

CLUSTER_ID=$(aws emr create-cluster \
  --region "$REGION" \
  --name "multi-master-emr-cluster" \
  --release-label emr-6.15.0 \
  --instance-groups '[{"Name":"Master","InstanceGroupType":"MASTER","InstanceType":"m7g.xlarge","InstanceCount":3},{"Name":"Core","InstanceGroupType":"CORE","InstanceType":"m7g.xlarge","InstanceCount":1}]' \
  --ec2-attributes "{\"SubnetId\":\"${SUBNET_ID}\",\"InstanceProfile\":\"${EC2_ROLE}\"}" \
  --service-role "$SERVICE_ROLE" \
  --no-termination-protected \
  --placement-group-configs '[{"InstanceRole":"MASTER","PlacementStrategy":"SPREAD"}]' \
  --no-auto-terminate \
  --query 'ClusterId' --output text)

mkdir -p "$(dirname "$OUT")"
printf '{"EMRClusterId": "%s"}\n' "$CLUSTER_ID" > "$OUT_JSON"
echo "Done." > "$OUT"
