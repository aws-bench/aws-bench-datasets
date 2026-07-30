#!/bin/bash
set -euo pipefail

REGION="us-west-2"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

GRACE=$(aws autoscaling describe-auto-scaling-groups --region "$REGION" \
    --auto-scaling-group-names "$ASG_NAME" \
    --query "AutoScalingGroups[0].HealthCheckGracePeriod" --output text)
HC_TYPE=$(aws autoscaling describe-auto-scaling-groups --region "$REGION" \
    --auto-scaling-group-names "$ASG_NAME" \
    --query "AutoScalingGroups[0].HealthCheckType" --output text)
LT_ID=$(aws autoscaling describe-auto-scaling-groups --region "$REGION" \
    --auto-scaling-group-names "$ASG_NAME" \
    --query "AutoScalingGroups[0].LaunchTemplate.LaunchTemplateId" --output text)
TG_ARN=$(aws autoscaling describe-auto-scaling-groups --region "$REGION" \
    --auto-scaling-group-names "$ASG_NAME" \
    --query "AutoScalingGroups[0].TargetGroupARNs[0]" --output text)

SG_ID=$(aws ec2 describe-launch-template-versions --region "$REGION" \
    --launch-template-id "$LT_ID" --versions '$Latest' \
    --query "LaunchTemplateVersions[0].LaunchTemplateData.SecurityGroupIds[0]" --output text)

INBOUND=$(aws ec2 describe-security-groups --region "$REGION" --group-ids "$SG_ID" \
    --query "SecurityGroups[0].IpPermissions" --output json)
INBOUND_COUNT=$(aws ec2 describe-security-groups --region "$REGION" --group-ids "$SG_ID" \
    --query "length(SecurityGroups[0].IpPermissions)" --output text)

HC_PROTO=$(aws elbv2 describe-target-groups --region "$REGION" --target-group-arns "$TG_ARN" \
    --query "TargetGroups[0].HealthCheckProtocol" --output text)
HC_PORT=$(aws elbv2 describe-target-groups --region "$REGION" --target-group-arns "$TG_ARN" \
    --query "TargetGroups[0].HealthCheckPort" --output text)
HC_PATH=$(aws elbv2 describe-target-groups --region "$REGION" --target-group-arns "$TG_ARN" \
    --query "TargetGroups[0].HealthCheckPath" --output text)
TRAFFIC_PORT=$(aws elbv2 describe-target-groups --region "$REGION" --target-group-arns "$TG_ARN" \
    --query "TargetGroups[0].Port" --output text)
UNHEALTHY=$(aws elbv2 describe-target-groups --region "$REGION" --target-group-arns "$TG_ARN" \
    --query "TargetGroups[0].UnhealthyThresholdCount" --output text)
NLB_ARN=$(aws elbv2 describe-target-groups --region "$REGION" --target-group-arns "$TG_ARN" \
    --query "TargetGroups[0].LoadBalancerArns[0]" --output text)

NLB_SCHEME=$(aws elbv2 describe-load-balancers --region "$REGION" --load-balancer-arns "$NLB_ARN" \
    --query "LoadBalancers[0].Scheme" --output text)
NLB_SUBNET=$(aws elbv2 describe-load-balancers --region "$REGION" --load-balancer-arns "$NLB_ARN" \
    --query "LoadBalancers[0].AvailabilityZones[0].SubnetId" --output text)

SUBNET_CIDR=$(aws ec2 describe-subnets --region "$REGION" --subnet-ids "$NLB_SUBNET" \
    --query "Subnets[0].CidrBlock" --output text)

cat > "$OUT" <<EOF
The instances in ASG $ASG_NAME are failing their health checks and are stuck in a
continuous terminate-and-replace loop.

Root cause: the instances' security group ($SG_ID) has no inbound rules
(IpPermissions has ${INBOUND_COUNT} entries), so it blocks the internal Network Load
Balancer's health-check requests. The ASG uses $HC_TYPE health checks, and the attached
target group ($TG_ARN) performs a ${HC_PROTO} health check on port ${HC_PORT}
(path ${HC_PATH}) while forwarding traffic on port ${TRAFFIC_PORT}. Its
IpPermissions is:
${INBOUND}

Because the security group allows no ingress, every health-check request to port
${HC_PORT} (${HC_PATH}) is dropped. After ${UNHEALTHY} consecutive failures each
instance is marked unhealthy, and because the ASG health-check grace period is
${GRACE} seconds the ASG immediately terminates and replaces the instance — producing
the observed flapping loop.

Fix: add inbound TCP rules to security group $SG_ID for the health-check port
${HC_PORT} and the traffic port ${TRAFFIC_PORT}, sourced from CIDR ${SUBNET_CIDR}
(the subnet where the ${NLB_SCHEME} NLB resides). For example:

  aws ec2 authorize-security-group-ingress --group-id $SG_ID \\
    --protocol tcp --port ${HC_PORT} --cidr ${SUBNET_CIDR} --region $REGION
  aws ec2 authorize-security-group-ingress --group-id $SG_ID \\
    --protocol tcp --port ${TRAFFIC_PORT} --cidr ${SUBNET_CIDR} --region $REGION

Once the health checks can reach the instances, they pass, stay InService, and the
terminate/replace loop stops.
EOF
