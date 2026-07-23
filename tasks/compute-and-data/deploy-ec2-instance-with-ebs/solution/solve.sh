#!/bin/bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
VOLUME_ID="${VOLUME_ID}"
SUBNET_ID="${SUBNET_ID}"
SECURITY_GROUP_ID="${SECURITY_GROUP_ID}"
IAM_ROLE_NAME="${IAM_ROLE_NAME}"
KEY_NAME="ec2-deploy-key-$(date +%s)"
OUT=/logs/agent/agent-output.txt

AMI_ID=$(aws ec2 describe-images --owners amazon \
  --filters "Name=name,Values=al2023-ami-2023*-x86_64" "Name=state,Values=available" \
  --query 'sort_by(Images, &CreationDate)[-1].ImageId' --output text --region "$REGION")

aws ec2 create-key-pair --key-name "$KEY_NAME" --region "$REGION" \
  --query 'KeyMaterial' --output text > /tmp/ec2-key.pem
chmod 400 /tmp/ec2-key.pem

PROFILE_NAME=$(aws iam list-instance-profiles-for-role --role-name "$IAM_ROLE_NAME" \
  --query 'InstanceProfiles[0].InstanceProfileName' --output text)

INSTANCE_ID=$(aws ec2 run-instances --image-id "$AMI_ID" --instance-type t3.micro \
  --key-name "$KEY_NAME" --subnet-id "$SUBNET_ID" --security-group-ids "$SECURITY_GROUP_ID" \
  --iam-instance-profile Name="$PROFILE_NAME" --region "$REGION" \
  --query 'Instances[0].InstanceId' --output text)

aws ec2 wait instance-running --instance-ids "$INSTANCE_ID" --region "$REGION"

aws ec2 attach-volume --volume-id "$VOLUME_ID" --instance-id "$INSTANCE_ID" \
  --device /dev/sdf --region "$REGION"

mkdir -p "$(dirname "$OUT")"
printf '{"InstanceId":"%s","KeyName":"%s"}\n' "$INSTANCE_ID" "$KEY_NAME" > /logs/agent/agent-output.json
echo "Done." > "$OUT"
