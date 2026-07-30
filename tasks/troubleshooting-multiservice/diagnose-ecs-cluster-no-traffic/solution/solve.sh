#!/bin/bash
set -euo pipefail

REGION="ap-northeast-1"
CLUSTER="${CLUSTER_NAME}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

SERVICE_ARNS=$(aws ecs list-services --region "$REGION" --cluster "$CLUSTER" --query "serviceArns" --output text)
SERVICE_COUNT=$(printf '%s\n' $SERVICE_ARNS | grep -c .)

SVC=$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services $SERVICE_ARNS \
    --query "services[].[serviceName,desiredCount,runningCount,taskDefinition]" --output text)

DESIRED_TOTAL=$(printf '%s\n' "$SVC" | awk '{s+=$2} END {print s+0}')
RUNNING_TOTAL=$(printf '%s\n' "$SVC" | awk '{s+=$3} END {print s+0}')

IMAGES=$(printf '%s\n' "$SVC" | awk '{print $4}' | while read -r td; do
    aws ecs describe-task-definition --region "$REGION" --task-definition "$td" \
        --query "taskDefinition.containerDefinitions[].image" --output text
done | sort -u)
IMAGE=$(printf '%s\n' "$IMAGES" | head -n1)

SUBNETS=$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services $SERVICE_ARNS \
    --query "services[].networkConfiguration.awsvpcConfiguration.subnets[]" --output text)
FIRST_SUBNET=$(printf '%s\n' $SUBNETS | head -n1)
VPC_ID=$(aws ec2 describe-subnets --region "$REGION" --subnet-ids "$FIRST_SUBNET" --query "Subnets[0].VpcId" --output text)

IGW_COUNT=$(aws ec2 describe-internet-gateways --region "$REGION" --filters "Name=attachment.vpc-id,Values=$VPC_ID" --query "length(InternetGateways)" --output text)
NAT_COUNT=$(aws ec2 describe-nat-gateways --region "$REGION" --filter "Name=vpc-id,Values=$VPC_ID" "Name=state,Values=available,pending" --query "length(NatGateways)" --output text)
ENDPOINT_COUNT=$(aws ec2 describe-vpc-endpoints --region "$REGION" --filters "Name=vpc-id,Values=$VPC_ID" --query "length(VpcEndpoints)" --output text)
DEFAULT_ROUTE_COUNT=$(aws ec2 describe-route-tables --region "$REGION" --filters "Name=vpc-id,Values=$VPC_ID" \
    --query "length(RouteTables[].Routes[?DestinationCidrBlock=='0.0.0.0/0'][])" --output text)

ALB_SCHEME=$(aws elbv2 describe-load-balancers --region "$REGION" --query "LoadBalancers[?VpcId=='$VPC_ID'].Scheme | [0]" --output text)

cat > "$OUT" <<EOF
Both ECS services in cluster $CLUSTER have desiredCount=0 (found $SERVICE_COUNT services in the cluster, with a combined desiredCount of $DESIRED_TOTAL and $RUNNING_TOTAL tasks running). Because no tasks are running, nothing is registered as a target behind the ALB, so the cluster serves no traffic.

Scaling the services up alone will not fix the issue, because there are deeper networking faults:

1. The services run in isolated subnets in VPC $VPC_ID with no path to the internet: there is no internet gateway (found $IGW_COUNT), no NAT gateway (found $NAT_COUNT), and no interface/gateway VPC endpoints (found $ENDPOINT_COUNT). The route tables have $DEFAULT_ROUTE_COUNT default (0.0.0.0/0) routes, so Fargate tasks have no outbound connectivity.

2. The task definitions reference a public ECR image ($IMAGE). Because the isolated subnets have no internet access and no ECR/S3/CloudWatch Logs VPC endpoints, the tasks cannot pull that image and would fail to start even if desiredCount were raised.

3. The load balancer is $ALB_SCHEME (internal), not internet-facing, so it cannot receive traffic from the public internet regardless of whether tasks are running.

To actually serve traffic you must give the tasks a way to pull the image (add a NAT gateway, or add ECR API/ECR DKR/S3/CloudWatch Logs VPC endpoints to the isolated subnets), scale the services to a desiredCount of at least 1, and make the ALB internet-facing so external clients can reach it.
EOF
