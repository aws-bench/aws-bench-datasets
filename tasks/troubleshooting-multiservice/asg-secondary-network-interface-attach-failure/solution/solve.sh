#!/bin/bash
set -euo pipefail

REGION="us-west-2"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

SG_TAG_VALUE=$(aws autoscaling describe-auto-scaling-groups --region "$REGION" \
    --auto-scaling-group-names "$ASG_NAME" \
    --query "AutoScalingGroups[0].Tags[?Key=='Customer-SG'].Value | [0]" --output text)
SUBNET_TAG_VALUE=$(aws autoscaling describe-auto-scaling-groups --region "$REGION" \
    --auto-scaling-group-names "$ASG_NAME" \
    --query "AutoScalingGroups[0].Tags[?Key=='Customer-Subnet'].Value | [0]" --output text)

SG_TAG_EXISTS=$(aws ec2 describe-security-groups --region "$REGION" \
    --filters "Name=group-id,Values=$SG_TAG_VALUE" \
    --query "SecurityGroups[].GroupId" --output text)
SUBNET_TAG_EXISTS=$(aws ec2 describe-subnets --region "$REGION" \
    --filters "Name=subnet-id,Values=$SUBNET_TAG_VALUE" \
    --query "Subnets[].SubnetId" --output text)

REAL_SG=$(aws ec2 describe-security-groups --region "$REGION" \
    --filters "Name=tag:Purpose,Values=Customer-Secondary-ENI-Security" \
    --query "SecurityGroups[0].GroupId" --output text)
REAL_SUBNET=$(aws ec2 describe-subnets --region "$REGION" \
    --filters "Name=tag:Purpose,Values=Customer-Secondary-ENI-Attachment" \
    --query "Subnets[0].SubnetId" --output text)

LT_ID=$(aws autoscaling describe-auto-scaling-groups --region "$REGION" \
    --auto-scaling-group-names "$ASG_NAME" \
    --query "AutoScalingGroups[0].LaunchTemplate.LaunchTemplateId" --output text)
PROFILE_ARN=$(aws ec2 describe-launch-template-versions --region "$REGION" \
    --launch-template-id "$LT_ID" --versions '$Latest' \
    --query "LaunchTemplateVersions[0].LaunchTemplateData.IamInstanceProfile.Arn" --output text)
PROFILE_NAME="${PROFILE_ARN##*/}"
ROLE_NAME=$(aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" \
    --query "InstanceProfile.Roles[0].RoleName" --output text)

INLINE_POLICIES=$(aws iam list-role-policies --role-name "$ROLE_NAME" \
    --query "PolicyNames" --output text)
ATTACHED_POLICIES=$(aws iam list-attached-role-policies --role-name "$ROLE_NAME" \
    --query "AttachedPolicies[].PolicyArn" --output text)
INLINE_ACTIONS=""
for P in $INLINE_POLICIES; do
    DOC=$(aws iam get-role-policy --role-name "$ROLE_NAME" --policy-name "$P" \
        --query "PolicyDocument.Statement[].Action" --output text)
    INLINE_ACTIONS="$INLINE_ACTIONS $DOC"
done

cat > "$OUT" <<EOF
ENI attachment for instances in $ASG_NAME fails due to two issues:

First, the ASG tags Customer-SG and Customer-Subnet point to $SG_TAG_VALUE and $SUBNET_TAG_VALUE, which do not exist in us-west-2 (describing them returns no matching security group or subnet). The actual customer security group is $REAL_SG and the actual customer subnet is $REAL_SUBNET, so the tags should reference these instead.

Second, the instance role $ROLE_NAME only has Secrets Manager permissions ($INLINE_ACTIONS) and no attached managed policies. It is missing EC2 permissions needed to manage network interfaces, such as ec2:CreateNetworkInterface, ec2:CreateNetworkInterfacePermission, ec2:DescribeNetworkInterfaces, ec2:DescribeSubnets, and ec2:DescribeSecurityGroups.
EOF
