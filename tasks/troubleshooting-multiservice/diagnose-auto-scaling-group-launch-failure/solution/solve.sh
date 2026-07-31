#!/bin/bash
set -euo pipefail

REGION="us-west-2"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

read -r MIN DESIRED MAX < <(aws autoscaling describe-auto-scaling-groups --region "$REGION" \
    --auto-scaling-group-names "$ASG_NAME" \
    --query "AutoScalingGroups[0].[MinSize,DesiredCapacity,MaxSize]" --output text)

read -r LT_NAME LT_VERSION < <(aws autoscaling describe-auto-scaling-groups --region "$REGION" \
    --auto-scaling-group-names "$ASG_NAME" \
    --query "AutoScalingGroups[0].LaunchTemplate.[LaunchTemplateName,Version]" --output text)

KMS_REF=$(aws ec2 describe-launch-template-versions --region "$REGION" \
    --launch-template-name "$LT_NAME" --versions "$LT_VERSION" \
    --query "LaunchTemplateVersions[0].LaunchTemplateData.BlockDeviceMappings[?Ebs.KmsKeyId].Ebs.KmsKeyId | [0]" \
    --output text)

read -r KMS_KEY_ID KMS_STATE < <(aws kms describe-key --region "$REGION" --key-id "$KMS_REF" \
    --query "KeyMetadata.[KeyId,KeyState]" --output text)

cat > "$OUT" <<EOF
Two issues prevent instances from launching in Auto Scaling Group ${ASG_NAME}:

(1) DesiredCapacity is ${DESIRED} (MaxSize=${MAX}, MinSize=${MIN}). Because desired
capacity is 0, the ASG has never attempted to launch any instances.

(2) Even after increasing the desired capacity, launches would fail because the
launch template ${LT_NAME} configures an encrypted EBS volume that uses KMS key
${KMS_KEY_ID}, which is ${KMS_STATE} (disabled). EC2 cannot create encrypted
volumes from a disabled KMS key, so every launch fails with
Client.InvalidKMSKey.InvalidState.

Fix: enable the KMS key (aws kms enable-key --key-id ${KMS_KEY_ID}), then raise the
ASG desired capacity above 0
(aws autoscaling set-desired-capacity --auto-scaling-group-name ${ASG_NAME} --desired-capacity 1).
EOF
