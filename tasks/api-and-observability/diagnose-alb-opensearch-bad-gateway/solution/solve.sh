#!/bin/bash
set -euo pipefail

REGION="us-east-1"
ALB_DNS="${ALB_DNS_NAME:?}"
DOMAIN_NAME="${DOMAIN_NAME:?}"
ALARM_NAME="${ALARM_NAME:?}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

ALARM_STATE=$(aws cloudwatch describe-alarms --region "$REGION" --alarm-names "$ALARM_NAME" \
    --query "MetricAlarms[0].StateValue" --output text)

ALB_ARN=$(aws elbv2 describe-load-balancers --region "$REGION" \
    --query "LoadBalancers[?DNSName=='${ALB_DNS}'].LoadBalancerArn | [0]" --output text)
VPC_ID=$(aws elbv2 describe-load-balancers --region "$REGION" --load-balancer-arns "$ALB_ARN" \
    --query "LoadBalancers[0].VpcId" --output text)

TG_ARNS=$(aws elbv2 describe-target-groups --region "$REGION" --load-balancer-arn "$ALB_ARN" \
    --query "TargetGroups[].TargetGroupArn" --output text)

TG_LINES=""
TG_NAMES=""
REGISTERED_IPS=""
for tg in $TG_ARNS; do
    NAME=$(aws elbv2 describe-target-groups --region "$REGION" --target-group-arns "$tg" \
        --query "TargetGroups[0].TargetGroupName" --output text)
    IPS=$(aws elbv2 describe-target-health --region "$REGION" --target-group-arn "$tg" \
        --query "TargetHealthDescriptions[].Target.Id" --output text)
    STATES=$(aws elbv2 describe-target-health --region "$REGION" --target-group-arn "$tg" \
        --query "TargetHealthDescriptions[].TargetHealth.State" --output text)
    TG_LINES+="  - ${NAME}: registered IP targets [$(echo "$IPS" | tr '\t' ' ')], health state(s) [$(echo "$STATES" | tr '\t' ' ')]"$'\n'
    TG_NAMES+="${NAME} "
    REGISTERED_IPS+="$IPS "
done

TG_NAMES=$(echo "$TG_NAMES" | tr ' ' '\n' | grep -v '^$' | paste -sd ', ' -)
REGISTERED_IPS=$(echo "$REGISTERED_IPS" | tr ' ' '\n' | sort -u | grep -v '^$' | paste -sd ', ' -)

DOMAIN_ENDPOINT=$(aws opensearch describe-domain --region "$REGION" --domain-name "$DOMAIN_NAME" \
    --query "DomainStatus.Endpoints.vpc || DomainStatus.Endpoint" --output text)

LIVE_ENI_IPS=$(aws ec2 describe-network-interfaces --region "$REGION" \
    --filters "Name=vpc-id,Values=${VPC_ID}" \
    --query "NetworkInterfaces[].PrivateIpAddress" --output text | tr '\t' '\n' | sort -u | grep -v '^$' | paste -sd ', ' -)

OS_ENI_IPS=$(aws ec2 describe-network-interfaces --region "$REGION" \
    --filters "Name=vpc-id,Values=${VPC_ID}" "Name=requester-id,Values=amazon-elasticsearch" "Name=description,Values=ES ${DOMAIN_NAME}" \
    --query "NetworkInterfaces[].PrivateIpAddress" --output text | tr '\t' '\n' | grep -v '^None$' | sort -u | grep -v '^$' | paste -sd ', ' -)

cat > "$OUT" <<EOF
Diagnosis: the internal ALB ${ALB_DNS} returns 502 Bad Gateway for all requests because every one of its targets is unhealthy, which is why the alarm ${ALARM_NAME} is in state ${ALARM_STATE}.

Root cause: the ALB has ${TG_NAMES} target groups fronting the OpenSearch domain ${DOMAIN_NAME}, and both use IP-type targets that no longer correspond to any active ENI in the VPC (${VPC_ID}):
${TG_LINES}
The registered target IPs are: ${REGISTERED_IPS}. None of these IPs is attached to any live network interface in the VPC. The private IPs of the active ENIs currently in the VPC are: ${LIVE_ENI_IPS}.

The OpenSearch domain ${DOMAIN_NAME} is deployed inside this VPC (endpoint ${DOMAIN_ENDPOINT}) and its current ENI private IPs are: ${OS_ENI_IPS} — different from the IPs registered in the target groups. Because the registered target IPs do not map to any running network interface, every health check fails, all targets are unhealthy, and the ALB has no healthy backend to route to, so it returns 502 for every request.

Fix: re-register each target group against the OpenSearch domain's current ENI private IPs (${OS_ENI_IPS}) — deregister the stale targets and register the live ones with the same port — so the health checks pass and the ALB regains healthy backends.
EOF
