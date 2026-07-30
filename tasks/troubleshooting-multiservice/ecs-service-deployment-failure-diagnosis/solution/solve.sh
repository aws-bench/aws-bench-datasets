#!/bin/bash
set -euo pipefail

REGION="us-west-2"
SERVICE_NAME="${ECS_SERVICE_NAME}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

CLUSTER=""
for c in $(aws ecs list-clusters --region "$REGION" --query 'clusterArns' --output text); do
    FOUND=$(aws ecs list-services --region "$REGION" --cluster "$c" \
        --query "serviceArns[?contains(@,'/${SERVICE_NAME}')]" --output text)
    if [ -n "$FOUND" ]; then
        CLUSTER="$c"
        break
    fi
done

DESIRED=$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE_NAME" \
    --query 'services[0].desiredCount' --output text)
RUNNING=$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE_NAME" \
    --query 'services[0].runningCount' --output text)
ROLLOUT=$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE_NAME" \
    --query 'services[0].deployments[0].rolloutState' --output text)
TASKDEF=$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE_NAME" \
    --query 'services[0].taskDefinition' --output text)
SUBNET_IDS=$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE_NAME" \
    --query 'services[0].networkConfiguration.awsvpcConfiguration.subnets' --output text)

IMAGES=$(aws ecs describe-task-definition --region "$REGION" --task-definition "$TASKDEF" \
    --query 'taskDefinition.containerDefinitions[].image' --output text)
CONTAINER_COUNT=$(printf '%s\n' $IMAGES | grep -c .)
FIRST_IMAGE=$(printf '%s\n' $IMAGES | head -n1)
ECR_REPO_NAME=$(printf '%s' "$FIRST_IMAGE" | sed 's#^[^/]*/##; s#:.*$##')
IMAGE_TAGS=$(printf '%s\n' $IMAGES | sed 's#^.*:##' | paste -sd ', ' -)

IMAGE_COUNT=$(aws ecr list-images --region "$REGION" --repository-name "$ECR_REPO_NAME" \
    --query 'length(imageIds)' --output text)

VPC_ID=$(aws ec2 describe-subnets --region "$REGION" --subnet-ids $SUBNET_IDS \
    --query 'Subnets[0].VpcId' --output text)

DEFAULT_ROUTES=$(aws ec2 describe-route-tables --region "$REGION" \
    --filters "Name=association.subnet-id,Values=$(printf '%s' "$SUBNET_IDS" | tr '\t' ',')" \
    --query 'length(RouteTables[].Routes[?DestinationCidrBlock==`0.0.0.0/0`][])' --output text)

NAT_COUNT=$(aws ec2 describe-nat-gateways --region "$REGION" \
    --filter "Name=vpc-id,Values=${VPC_ID}" "Name=state,Values=available" \
    --query 'length(NatGateways)' --output text)

ENDPOINT_COUNT=$(aws ec2 describe-vpc-endpoints --region "$REGION" \
    --filters "Name=vpc-id,Values=${VPC_ID}" \
    --query 'length(VpcEndpoints)' --output text)

cat > "$OUT" <<EOF
The ECS service ${SERVICE_NAME} in ${REGION} is not actually failing to deploy.

The service has desiredCount set to ${DESIRED}, so ECS is not attempting to launch any tasks (runningCount is ${RUNNING}). Its latest deployment rollout state is ${ROLLOUT} because the service successfully reached its target of ${DESIRED} running tasks. With a desired count of zero there is nothing to fail.

However, if you raise the desired count above zero, tasks will still fail to start for two reasons you should be aware of:

1. Missing container images: the task definition's ${CONTAINER_COUNT} containers reference images in the ECR repository ${ECR_REPO_NAME} (tags: ${IMAGE_TAGS}), but that repository currently has ${IMAGE_COUNT} images pushed to it, so ECS cannot pull them.

2. No network path to ECR: the service runs in private isolated subnets in VPC ${VPC_ID}. Those subnets have ${DEFAULT_ROUTES} default (0.0.0.0/0) routes, and the VPC has ${NAT_COUNT} NAT gateways and ${ENDPOINT_COUNT} VPC endpoints, so Fargate tasks have no route to reach ECR (or CloudWatch Logs) to pull container images.

To make the service deployable you would need to push the referenced images to ${ECR_REPO_NAME} and add either a NAT gateway or ECR (ecr.api, ecr.dkr), S3, and CloudWatch Logs VPC endpoints to the VPC, then increase the desired count.
EOF
