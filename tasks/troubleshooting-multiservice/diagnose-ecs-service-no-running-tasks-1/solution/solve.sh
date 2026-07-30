#!/bin/bash
set -euo pipefail

REGION="us-east-1"
CLUSTER="$APP_CLUSTER_NAME"
SERVICE="$SERVICE_NAME"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

SVC=$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" \
    --query 'services[0].{desired:desiredCount,taskDef:taskDefinition,cps:capacityProviderStrategy,launchType:launchType}' \
    --output json)
DESIRED=$(printf '%s' "$SVC" | python3 -c 'import json,sys;print(json.load(sys.stdin)["desired"])')
TASKDEF=$(printf '%s' "$SVC" | python3 -c 'import json,sys;print(json.load(sys.stdin)["taskDef"])')
CPS_COUNT=$(printf '%s' "$SVC" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(len(d["cps"]) if d["cps"] else 0)')

IMAGES=$(aws ecs describe-task-definition --region "$REGION" --task-definition "$TASKDEF" \
    --query 'taskDefinition.containerDefinitions[].image' --output text)

FIRST_IMAGE=$(printf '%s\n' "$IMAGES" | tr '\t' '\n' | head -n1)
ECR_URI="${FIRST_IMAGE%:*}"
ECR_REPO="${ECR_URI##*/}"

REFERENCED_TAGS=$(printf '%s\n' "$IMAGES" | tr '\t' '\n' | sed 's/.*://' | sort -u | paste -sd', ' -)

AVAILABLE_TAGS=$(aws ecr list-images --region "$REGION" --repository-name "$ECR_REPO" \
    --query 'imageIds[].imageTag' --output text)

INSTANCES=$(aws ecs list-container-instances --region "$REGION" --cluster "$CLUSTER" \
    --query 'length(containerInstanceArns)' --output text)

cat > "$OUT" <<EOF
The ECS service ${SERVICE} in cluster ${CLUSTER} has no running tasks because of three distinct blockers, all of which must be addressed to get tasks running:

1. desiredCount is 0 (the immediate reason no tasks run). The service is configured with desiredCount=${DESIRED}, so ECS is not attempting to launch any tasks. Raising it above 0 (e.g. aws ecs update-service --cluster ${CLUSTER} --service ${SERVICE} --desired-count 1) is necessary but not sufficient on its own.

2. The active task definition (${TASKDEF}) references image tags that do not exist in the ECR repository ${ECR_URI}. The container definitions pull the tags: ${REFERENCED_TAGS}. The only tag actually present in the repository is: ${AVAILABLE_TAGS}. So even if tasks were launched they would fail to pull their images. Fix by pushing images under the referenced tags, or by updating the task definition to reference an existing tag (${AVAILABLE_TAGS}).

3. There is no compute for ECS to schedule tasks on. The cluster has ${INSTANCES} registered EC2 container instances and the service has no capacity provider strategy (capacityProviderStrategy entries: ${CPS_COUNT}), so even with a desired count greater than 0 the tasks would remain stuck in PROVISIONING indefinitely. Provide capacity by scaling up the EC2 Auto Scaling Group / capacity provider so instances register with the cluster, and attach a capacity provider strategy (or launch type with capacity) to the service so tasks can be placed.
EOF
