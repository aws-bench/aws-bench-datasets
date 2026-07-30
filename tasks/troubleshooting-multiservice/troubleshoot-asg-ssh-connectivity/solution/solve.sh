#!/bin/bash
set -euo pipefail

REGION="us-west-2"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

LT_ID=$(aws autoscaling describe-auto-scaling-groups --region "$REGION" \
    --auto-scaling-group-names "$ASG_NAME" \
    --query "AutoScalingGroups[0].LaunchTemplate.LaunchTemplateId" --output text)

INSTANCE_ID=$(aws autoscaling describe-auto-scaling-groups --region "$REGION" \
    --auto-scaling-group-names "$ASG_NAME" \
    --query "AutoScalingGroups[0].Instances[0].InstanceId" --output text)

SUBNET_ID=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE_ID" \
    --query "Reservations[0].Instances[0].SubnetId" --output text)

NACL_ID=$(aws ec2 describe-network-acls --region "$REGION" \
    --filters "Name=association.subnet-id,Values=$SUBNET_ID" \
    --query "NetworkAcls[0].NetworkAclId" --output text)

KEY_NAME=$(aws ec2 describe-launch-template-versions --region "$REGION" \
    --launch-template-id "$LT_ID" --versions '$Latest' \
    --query "LaunchTemplateVersions[0].LaunchTemplateData.KeyName" --output text)

PROFILE_NAME=$(aws ec2 describe-launch-template-versions --region "$REGION" \
    --launch-template-id "$LT_ID" --versions '$Latest' \
    --query "LaunchTemplateVersions[0].LaunchTemplateData.IamInstanceProfile.Name" --output text)

ROLE_NAME=$(aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" \
    --query "InstanceProfile.Roles[0].RoleName" --output text)

SSM_POLICY=$(aws iam list-attached-role-policies --role-name "$ROLE_NAME" \
    --query "AttachedPolicies[?PolicyName=='AmazonSSMManagedInstanceCore'].PolicyName | [0]" \
    --output text)

SUBNET_CIDR=$(aws ec2 describe-subnets --region "$REGION" --subnet-ids "$SUBNET_ID" \
    --query "Subnets[0].CidrBlock" --output text)

MAP_PUBLIC=$(aws ec2 describe-subnets --region "$REGION" --subnet-ids "$SUBNET_ID" \
    --query "Subnets[0].MapPublicIpOnLaunch" --output text)

DENY_RULE=$(aws ec2 describe-network-acls --region "$REGION" --network-acl-ids "$NACL_ID" \
    --query "NetworkAcls[0].Entries[?Egress==\`false\` && RuleAction=='deny' && PortRange.From==\`22\`].RuleNumber | [0]" \
    --output text)

cat > "$OUT" <<EOF
SSH to the instances in Auto Scaling Group ${ASG_NAME} in ${REGION} is blocked by three independent problems, all of which would have to be worked around for SSH to succeed:

1. No SSH key pair. The ASG's launch template (${LT_ID}) launches instances with no key pair configured (KeyName=${KEY_NAME}), so there is no key on the instances to authenticate an SSH login.

2. Private subnet, no public connectivity. The instances land in subnet ${SUBNET_ID} (CIDR ${SUBNET_CIDR}), a private subnet that does not auto-assign public IPs (MapPublicIpOnLaunch=${MAP_PUBLIC}). The instances have no public IP address and are not directly reachable from the internet.

3. Network ACL denies inbound SSH. The network ACL ${NACL_ID} associated with the subnet has an explicit DENY entry (rule ${DENY_RULE}) for inbound TCP port 22, which is evaluated before the allow-all rule and drops all inbound SSH traffic regardless of any security group rules.

Options for connecting: The best and already-configured option is AWS Systems Manager Session Manager. The instances' IAM role (${ROLE_NAME}, via instance profile ${PROFILE_NAME}) has the ${SSM_POLICY} managed policy attached, so Session Manager is ready to use:

    aws ssm start-session --target <instance-id> --region ${REGION}

Get the instance id from the ASG with 'aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names ${ASG_NAME} --region ${REGION}'. Session Manager needs no key pair, no public IP, and no inbound ports, and is unaffected by the NACL because it is an outbound-initiated connection to the SSM service. If you specifically require SSH, you would instead have to relaunch instances with a key pair, remove or override the NACL rule ${DENY_RULE} deny on port 22, and provide reachability (a bastion host, SSM port forwarding, or a public IP) — but Session Manager is the recommended path.
EOF
