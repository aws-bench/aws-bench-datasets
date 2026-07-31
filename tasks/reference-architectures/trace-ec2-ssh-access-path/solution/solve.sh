#!/bin/bash
set -euo pipefail

REGION="us-east-1"
INSTANCE_ID="${INSTANCE_ID:?}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

PUBLIC_IP=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE_ID" \
    --query "Reservations[0].Instances[0].PublicIpAddress" --output text)
SUBNET_ID=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE_ID" \
    --query "Reservations[0].Instances[0].SubnetId" --output text)
SG_IDS=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE_ID" \
    --query "Reservations[0].Instances[0].SecurityGroups[].GroupId" --output text)
PROFILE_ARN=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE_ID" \
    --query "Reservations[0].Instances[0].IamInstanceProfile.Arn" --output text)

SG_COUNT=$(printf '%s\n' $SG_IDS | grep -c .)

NO_INGRESS_SG=$(aws ec2 describe-security-groups --region "$REGION" --group-ids $SG_IDS \
    --query 'SecurityGroups[?length(IpPermissions)==`0`].GroupName | [0]' --output text)
SSH_SG=$(aws ec2 describe-security-groups --region "$REGION" --group-ids $SG_IDS \
    --query 'SecurityGroups[?length(IpPermissions)>`0`].GroupName | [0]' --output text)
SSH_PORT=$(aws ec2 describe-security-groups --region "$REGION" --group-ids $SG_IDS \
    --query 'SecurityGroups[?length(IpPermissions)>`0`].IpPermissions[0].FromPort | [0]' --output text)
SSH_CIDR=$(aws ec2 describe-security-groups --region "$REGION" --group-ids $SG_IDS \
    --query 'SecurityGroups[?length(IpPermissions)>`0`].IpPermissions[0].IpRanges[0].CidrIp | [0]' --output text)

IGW_ROUTE=$(aws ec2 describe-route-tables --region "$REGION" \
    --filters "Name=association.subnet-id,Values=${SUBNET_ID}" \
    --query "RouteTables[0].Routes[?DestinationCidrBlock=='0.0.0.0/0'].GatewayId | [0]" --output text)

PROFILE_NAME="${PROFILE_ARN##*/}"
ROLE_NAME=$(aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" \
    --query "InstanceProfile.Roles[0].RoleName" --output text)
SSM_POLICY=$(aws iam list-attached-role-policies --role-name "$ROLE_NAME" \
    --query "AttachedPolicies[?PolicyName=='AmazonSSMManagedInstanceCore'].PolicyName | [0]" --output text)

SSM_PING=$(aws ssm describe-instance-information --region "$REGION" \
    --filters "Key=InstanceIds,Values=${INSTANCE_ID}" \
    --query "InstanceInformationList[0].PingStatus" --output text)

cat > "$OUT" <<EOF
End-to-end SSH access trace for instance ${INSTANCE_ID}

Verdict: the exported \`SshCommand\` is misleading. Direct SSH from the public
internet does NOT work even though the instance has a public IP (${PUBLIC_IP})
and sits in a public subnet (${SUBNET_ID}, whose route table sends 0.0.0.0/0 to
the internet gateway ${IGW_ROUTE}). The reason is the security group layer, not
routing.

Topology: the instance has ${SG_COUNT} security groups attached (${SG_IDS}).
The ${NO_INGRESS_SG} security group has NO ingress rules at all. The ${SSH_SG}
security group has a single ingress rule allowing TCP port ${SSH_PORT} from
${SSH_CIDR} (the VPC CIDR) only, NOT 0.0.0.0/0. Packets arriving at port 22 from
any non-VPC source are dropped by the security group, which is why the
connection times out from your laptop.

Why your colleague on the corporate VPN succeeds: their traffic may reach the
instance with a source address inside the ${SSH_CIDR} VPC CIDR range (the VPN
routes/NATs them into that range), so it matches the ingress rule; or they are
using SSM Session Manager, which requires no inbound ingress rule.

What actually works — SSM Session Manager: the instance IAM role ${ROLE_NAME}
has the ${SSM_POLICY} managed policy attached, and the SSM agent reports
PingStatus=${SSM_PING}. Session Manager connects over the instance's outbound
HTTPS to the SSM service and needs no security group ingress rule:

    aws ssm start-session --target ${INSTANCE_ID}

Net: use SSM Session Manager, not direct public SSH.
EOF
