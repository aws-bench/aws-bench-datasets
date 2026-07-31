#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OTHER_REGION="ap-southeast-7"
RULE_NAME="${EVENTBRIDGE_RULE_NAME}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

TASK_DEF_ARN=$(aws events list-targets-by-rule --rule "$RULE_NAME" --region "$REGION" \
    --query "Targets[0].EcsParameters.TaskDefinitionArn" --output text)

S3_LOCATION=$(aws ecs describe-task-definition --task-definition "$TASK_DEF_ARN" --region "$REGION" \
    --query "taskDefinition.containerDefinitions[0].environment[?name=='S3_LOCATION'].value | [0]" --output text)

S3_LOCATION_BUCKET=$(printf '%s' "$S3_LOCATION" | sed -E 's#^s3://([^/]+)/.*#\1#')

TASK_ROLE_ARN=$(aws ecs describe-task-definition --task-definition "$TASK_DEF_ARN" --region "$REGION" \
    --query "taskDefinition.taskRoleArn" --output text)
TASK_ROLE_NAME="${TASK_ROLE_ARN##*/}"

TASK_ROLE_POLICY=$(aws iam list-role-policies --role-name "$TASK_ROLE_NAME" \
    --query "PolicyNames[0]" --output text)

DEPLOYMENT_BUCKET=$(aws iam get-role-policy --role-name "$TASK_ROLE_NAME" --policy-name "$TASK_ROLE_POLICY" \
    --query "PolicyDocument.Statement[].Resource" --output text \
    | tr '\t' '\n' | grep -oE 's3:::[a-z0-9.-]+' | sed 's/^s3::://' | sort -u | head -1)

ACCOUNT_BUCKETS=$(aws s3api list-buckets --query "Buckets[].Name" --output text)

AP7_RULES=$(aws events list-rules --region "$OTHER_REGION" --query "length(Rules)" --output text 2>/dev/null || echo 0)
AP7_CLUSTERS=$(aws ecs list-clusters --region "$OTHER_REGION" --query "length(clusterArns)" --output text 2>/dev/null || echo 0)
AP7_TASKDEFS=$(aws ecs list-task-definitions --region "$OTHER_REGION" --query "length(taskDefinitionArns)" --output text 2>/dev/null || echo 0)

cat > "$OUT" <<EOF
Your EventBridge rule ${RULE_NAME} has two issues preventing it from working, and no resources exist in ${OTHER_REGION}.

Issue 1: Hardcoded S3 location mismatch
The ECS task definition has a hardcoded S3_LOCATION environment variable set to ${S3_LOCATION}, which points at bucket ${S3_LOCATION_BUCKET}. That bucket does not exist in this account. The task role ${TASK_ROLE_NAME} only has S3 read permissions for the deployment bucket ${DEPLOYMENT_BUCKET}, so when the task runs it fails with an access-denied error trying to read the wrong bucket. Because S3_LOCATION is a literal string baked into the CloudFormation template, redeploying the stack does not fix it and the wrong bucket is always used.

Issue 2: EventBridge rule pinned to a specific task definition revision
The rule target references the task definition by its full ARN including the revision number: ${TASK_DEF_ARN}. CloudFormation resolves Ref on an ECS task definition to the full ARN with the revision, so any code change you deploy creates a new task definition revision, but the rule keeps invoking the pinned old revision. This is why your code changes are not reflected in task execution.

No resources in ${OTHER_REGION}
There are no EventBridge rules, ECS clusters, or ECS task definitions from this stack deployed in ${OTHER_REGION} (found ${AP7_RULES} rules, ${AP7_CLUSTERS} clusters, ${AP7_TASKDEFS} task definitions). All of the stack's resources live in ${REGION}.
EOF
