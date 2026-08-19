#!/bin/bash
set -euo pipefail

REGION="us-west-2"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

ASG=$(aws autoscaling describe-auto-scaling-groups --region "$REGION" \
    --auto-scaling-group-names "$ASG_NAME" \
    --query "AutoScalingGroups[0].[HealthCheckType,HealthCheckGracePeriod,LaunchTemplate.LaunchTemplateId]" \
    --output text)
HEALTH_CHECK_TYPE=$(echo "$ASG" | awk '{print $1}')
GRACE=$(echo "$ASG" | awk '{print $2}')
LT_ID=$(echo "$ASG" | awk '{print $3}')

TG_ARN=$(aws autoscaling describe-auto-scaling-groups --region "$REGION" \
    --auto-scaling-group-names "$ASG_NAME" \
    --query "AutoScalingGroups[0].TargetGroupARNs[0]" --output text)

SG_ID=$(aws ec2 describe-launch-template-versions --region "$REGION" \
    --launch-template-id "$LT_ID" --versions '$Latest' \
    --query "LaunchTemplateVersions[0].LaunchTemplateData.SecurityGroupIds[0]" --output text)

TG=$(aws elbv2 describe-target-groups --region "$REGION" --target-group-arns "$TG_ARN" \
    --query "TargetGroups[0].[TargetGroupName,HealthCheckProtocol,HealthCheckPort,HealthCheckPath]" \
    --output text)
TG_NAME=$(echo "$TG" | awk '{print $1}')
HC_PROTO=$(echo "$TG" | awk '{print $2}')
HC_PORT=$(echo "$TG" | awk '{print $3}')
HC_PATH=$(echo "$TG" | awk '{print $4}')

LB_ARN=$(aws elbv2 describe-target-groups --region "$REGION" --target-group-arns "$TG_ARN" \
    --query "TargetGroups[0].LoadBalancerArns[0]" --output text)
LB=$(aws elbv2 describe-load-balancers --region "$REGION" --load-balancer-arns "$LB_ARN" \
    --query "LoadBalancers[0].[Type,Scheme]" --output text)
LB_TYPE=$(echo "$LB" | awk '{print $1}')
LB_SCHEME=$(echo "$LB" | awk '{print $2}')

INGRESS=$(aws ec2 describe-security-groups --region "$REGION" --group-ids "$SG_ID" \
    --query "SecurityGroups[0].IpPermissions[].[IpProtocol,FromPort,ToPort]" --output text)
SG_RULES=$(echo "$INGRESS" | awk '{
    if ($1 == "-1") { print "all traffic" }
    else if ($2 == $3) { printf "%s %s\n", toupper($1), $2 }
    else { printf "%s %s-%s\n", toupper($1), $2, $3 }
}' | paste -sd ',' - | sed 's/,/, /g')

INGRESS_SRC=$(aws ec2 describe-security-groups --region "$REGION" --group-ids "$SG_ID" \
    --query "SecurityGroups[0].IpPermissions[].UserIdGroupPairs[].GroupId" --output text \
    | tr '\t' '\n' | sort -u | paste -sd ',' - | sed 's/,/, /g')

cat > "$OUT" <<EOF
Root cause: the security group ${SG_ID} attached to the Auto Scaling Group ${ASG_NAME} instances does not allow inbound traffic on port ${HC_PORT}, which is the health check port configured on target group ${TG_NAME}.

The target group ${TG_NAME} uses ${HC_PROTO} health checks on port ${HC_PORT} at path ${HC_PATH}. The load balancer (${LB_ARN}) is an ${LB_SCHEME} ${LB_TYPE} load balancer, so with a Network Load Balancer the health check traffic comes from the NLB's private IP address in the subnet, not from a source security group that could be referenced. The instance security group ${SG_ID} only has self-referencing ingress rules (${SG_RULES} from itself, source group ${INGRESS_SRC}) and no rule opening port ${HC_PORT}, so the NLB health check packets are dropped.

Because the ASG uses ${HEALTH_CHECK_TYPE} health checks (grace period ${GRACE}s), this causes the ASG to continuously cycle instances: each instance launches, fails the ELB health check after the grace period, is marked unhealthy and terminated, and a replacement is launched.

Fix: add an inbound rule to security group ${SG_ID} allowing TCP on port ${HC_PORT} from the VPC subnet CIDR so the NLB health check traffic reaches the instances.

Once the health checks can reach the instances, they pass, the targets stay healthy, and the terminate/replace loop stops.
EOF
