#!/bin/bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
CLUSTER="${CLUSTER_NAME}"
ASG="${ASG_NAME}"
OUT_JSON=/logs/agent/agent-output.json
OUT_TXT=/logs/agent/agent-output.txt

SUFFIX="${CLUSTER##*-}"
NS_NAME="bench-namespace-${SUFFIX}.local"
SD_SERVICE_NAME="bench-service-${SUFFIX}"
ECS_SERVICE_NAME="bench-ecs-service-${SUFFIX}"
TASK_FAMILY="bench-task-${SUFFIX}"
CONTAINER_NAME="bench-container"

SUBNET_ID=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$ASG" \
  --region "$REGION" --query 'AutoScalingGroups[0].VPCZoneIdentifier' --output text | tr ',' '\n' | head -n1)
VPC_ID=$(aws ec2 describe-subnets --subnet-ids "$SUBNET_ID" --region "$REGION" \
  --query 'Subnets[0].VpcId' --output text)

OP_ID=$(aws servicediscovery create-private-dns-namespace --name "$NS_NAME" --vpc "$VPC_ID" \
  --region "$REGION" --query 'OperationId' --output text)

for _ in $(seq 1 30); do
  read -r STATUS NS_ID <<<"$(aws servicediscovery get-operation --operation-id "$OP_ID" \
    --region "$REGION" --query 'Operation.[Status,Targets.NAMESPACE]' --output text 2>/dev/null || true)"
  [ "$STATUS" = "SUCCESS" ] && break
  sleep 5
done

SD_SERVICE_ARN=$(aws servicediscovery create-service --name "$SD_SERVICE_NAME" \
  --namespace-id "$NS_ID" --region "$REGION" \
  --dns-config "NamespaceId=${NS_ID},DnsRecords=[{Type=SRV,TTL=60}]" \
  --health-check-custom-config FailureThreshold=1 \
  --query 'Service.Arn' --output text)

aws ecs register-task-definition --region "$REGION" --family "$TASK_FAMILY" \
  --network-mode bridge --requires-compatibilities EC2 --cpu 256 --memory 256 \
  --container-definitions "[{\"name\":\"${CONTAINER_NAME}\",\"image\":\"public.ecr.aws/docker/library/nginx:latest\",\"essential\":true,\"portMappings\":[{\"containerPort\":80,\"hostPort\":0,\"protocol\":\"tcp\"}],\"memory\":256,\"cpu\":256}]"

aws ecs create-service --cluster "$CLUSTER" --service-name "$ECS_SERVICE_NAME" \
  --task-definition "$TASK_FAMILY" --desired-count 1 --launch-type EC2 --region "$REGION" \
  --scheduling-strategy REPLICA \
  --service-registries "[{\"registryArn\":\"${SD_SERVICE_ARN}\",\"containerName\":\"${CONTAINER_NAME}\",\"containerPort\":80}]"

mkdir -p "$(dirname "$OUT_JSON")"
printf '{"service_name": "%s", "namespace_name": "%s", "cloudmap_service_name": "%s"}\n' "$ECS_SERVICE_NAME" "$NS_NAME" "$SD_SERVICE_NAME" > "$OUT_JSON"
echo "Done." > "$OUT_TXT"
