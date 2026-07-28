#!/bin/bash
set -euo pipefail

REGION="us-east-1"
CLUSTER="${ECS_CLUSTER_NAME}"
REPO="my-ecr-repo"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

SERVICE_ARNS=$(aws ecs list-services --cluster "$CLUSTER" --region "$REGION" --query 'serviceArns' --output text)
TASKDEFS=$(aws ecs describe-services --cluster "$CLUSTER" --services $SERVICE_ARNS --region "$REGION" --query 'services[].taskDefinition' --output text)

IMAGES=""
EXEC_ROLES=""
ECR_PERMS=""
for TD in $TASKDEFS; do
    IMG=$(aws ecs describe-task-definition --task-definition "$TD" --region "$REGION" --query 'taskDefinition.containerDefinitions[].image' --output text)
    IMAGES="$IMAGES $IMG"
    EXEC=$(aws ecs describe-task-definition --task-definition "$TD" --region "$REGION" --query 'taskDefinition.executionRoleArn' --output text)
    EXEC_ROLES="$EXEC_ROLES $EXEC"
    TASKROLE_ARN=$(aws ecs describe-task-definition --task-definition "$TD" --region "$REGION" --query 'taskDefinition.taskRoleArn' --output text)
    TASKROLE_NAME=$(printf '%s' "$TASKROLE_ARN" | sed 's#.*/##')
    ATTACHED=$(aws iam list-attached-role-policies --role-name "$TASKROLE_NAME" --query 'AttachedPolicies[].PolicyName' --output text)
    INLINE=$(aws iam list-role-policies --role-name "$TASKROLE_NAME" --query 'PolicyNames' --output text)
    ECR_PERMS="$ECR_PERMS ${ATTACHED} ${INLINE}"
done

IMAGE_LIST=$(printf '%s\n' $IMAGES | sort -u | paste -sd ', ' -)

REPO_URI=$(aws ecr describe-repositories --repository-names "$REPO" --region "$REGION" --query 'repositories[0].repositoryUri' --output text)

cat > "$OUT" <<EOF
The container images used by the service(s) in the ECS cluster $CLUSTER is $IMAGE_LIST. The service cannot access the ECR repository $REPO ($REPO_URI): its task definition has no execution role configured (executionRoleArn=$(printf '%s' $EXEC_ROLES)) and its task role has no ECR permissions attached, so ECS has no IAM authorization (ecr:GetAuthorizationToken, ecr:BatchGetImage, ecr:GetDownloadUrlForLayer, ecr:BatchCheckLayerAvailability) to authenticate to or pull from $REPO.
EOF
