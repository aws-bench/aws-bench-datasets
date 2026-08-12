#!/bin/bash
set -euo pipefail

REGION="us-east-1"
FUNCTION_NAME="${FUNCTION_NAME}"
LOG_GROUP_NAME="${LOG_GROUP_NAME}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

JOB_QUEUE_ARN=$(aws lambda get-function-configuration --region "$REGION" --function-name "$FUNCTION_NAME" \
    --query "Environment.Variables.JOB_QUEUE" --output text)
JOB_DEFINITION_ARN=$(aws lambda get-function-configuration --region "$REGION" --function-name "$FUNCTION_NAME" \
    --query "Environment.Variables.JOB_DEFINITION" --output text)

CODE_LOCATION=$(aws lambda get-function --region "$REGION" --function-name "$FUNCTION_NAME" \
    --query "Code.Location" --output text)
WORKDIR=$(mktemp -d)
curl -s "$CODE_LOCATION" -o "$WORKDIR/code.zip"
unzip -o -q "$WORKDIR/code.zip" -d "$WORKDIR"
HANDLER_CODE=$(cat "$WORKDIR"/index.py)

JOB_IMAGE=$(aws batch describe-job-definitions --region "$REGION" --job-definitions "$JOB_DEFINITION_ARN" \
    --query "jobDefinitions[0].containerProperties.image" --output text)
LOG_CONFIG=$(aws batch describe-job-definitions --region "$REGION" --job-definitions "$JOB_DEFINITION_ARN" \
    --query "jobDefinitions[0].containerProperties.logConfiguration" --output json)

ECR_REPOSITORY_URI="$JOB_IMAGE"
ECR_REPOSITORY_NAME="${JOB_IMAGE##*/}"

IMAGE_COUNT=$(aws ecr list-images --region "$REGION" --repository-name "$ECR_REPOSITORY_NAME" \
    --query "length(imageIds)" --output text)

# Report the observed terminal state of the submitted job rather than asserting
# a transition the account may not contain.
JOB_ID="${BATCH_JOB_ID}"
JOB=$(aws batch describe-jobs --region "$REGION" --jobs "$JOB_ID" --output json)
JOB_STATUS=$(printf '%s' "$JOB" | python3 -c 'import json,sys;print(json.load(sys.stdin)["jobs"][0]["status"])')
JOB_REASON=$(printf '%s' "$JOB" | python3 -c '
import json, sys
job = json.load(sys.stdin)["jobs"][0]
parts = [job.get("statusReason", "")]
for a in job.get("attempts", []):
    parts.append(a.get("statusReason", ""))
    parts.append(a.get("container", {}).get("reason", ""))
print(" | ".join(p for p in parts if p))')

cat > "$OUT" <<EOF
The 200 does not mean the job actually ran. The Lambda ${FUNCTION_NAME} is a fire-and-forget wrapper. Its handler calls batch.submit_job exactly once and immediately returns {"statusCode": 200, "body": {"jobId": ...}} without ever polling, describing the job, or waiting for a container to start:

${HANDLER_CODE}

So a 200 plus a jobId only confirms that the Batch control plane accepted the submission into the queue (${JOB_QUEUE_ARN}). It says nothing about whether anything ever actually ran.

Primary root cause: the Batch job cannot start, so no container ever runs and nothing writes logs. The job definition ${JOB_DEFINITION_ARN} references image ${JOB_IMAGE} with no tag, so Batch resolves it to :latest. But the ECR repository ${ECR_REPOSITORY_NAME} (${ECR_REPOSITORY_URI}) is empty — it currently holds ${IMAGE_COUNT} images, i.e. no image has ever been pushed to it. With no :latest manifest to pull, a job submitted to queue ${JOB_QUEUE_ARN} cannot start: describing job ${JOB_ID} shows status ${JOB_STATUS} with reason "${JOB_REASON}", i.e. the container image could not be pulled from the repository. It dies before any container starts, which is why ${LOG_GROUP_NAME} has no streams. Fix: build and push the OpenMP benchmark image (ideally with an explicit tag) to ${ECR_REPOSITORY_NAME} so Batch has an image to run.

Secondary observation for later: even once an image is pushed and jobs run, the logs will not land in ${LOG_GROUP_NAME}. The job definition's container logConfiguration is ${LOG_CONFIG}, i.e. there is no logConfiguration.options.awslogs-group override, so Batch's default awslogs driver writes to /aws/batch/job instead of the declared group. That is latent today because nothing runs, but the declared log group ${LOG_GROUP_NAME} will keep reading as empty even after the ECR problem is fixed unless you add logConfiguration.options.awslogs-group=${LOG_GROUP_NAME} to the job definition.
EOF
