#!/bin/bash
set -euo pipefail

REGION="us-east-1"
PIPELINE="${PIPELINE_NAME}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

SOURCE_CFG=$(aws codepipeline get-pipeline --name "$PIPELINE" --region "$REGION" \
    --query "pipeline.stages[?name=='Source'].actions[0].[actionTypeId.provider,configuration.RepositoryName,configuration.BranchName]" \
    --output text)
PROVIDER=$(echo "$SOURCE_CFG" | awk '{print $1}')
REPO=$(echo "$SOURCE_CFG" | awk '{print $2}')
BRANCH=$(echo "$SOURCE_CFG" | awk '{print $3}')

LAMBDA=$(aws codepipeline get-pipeline --name "$PIPELINE" --region "$REGION" \
    --query "pipeline.stages[?name=='Deploy'].actions[0].configuration.FunctionName" \
    --output text)
USER_PARAMS=$(aws codepipeline get-pipeline --name "$PIPELINE" --region "$REGION" \
    --query "pipeline.stages[?name=='Deploy'].actions[0].configuration.UserParameters" \
    --output text)
GLUE_JOB=$(echo "$USER_PARAMS" | python3 -c "import sys,json;print(json.load(sys.stdin)['glue_job_name'])")
GLUE_ROLE=$(echo "$USER_PARAMS" | python3 -c "import sys,json;print(json.load(sys.stdin)['glue_role'])")

BRANCH_COUNT=$(aws codecommit list-branches --repository-name "$REPO" --region "$REGION" \
    --query "length(branches)" --output text)

EXEC=$(aws codepipeline list-pipeline-executions --pipeline-name "$PIPELINE" --region "$REGION" \
    --query "[length(pipelineExecutionSummaries), pipelineExecutionSummaries[0].status]" --output text)
EXEC_COUNT=$(echo "$EXEC" | awk '{print $1}')
LAST_EXEC=$(echo "$EXEC" | awk '{print $2}')
SOURCE_ERR=$(aws codepipeline list-action-executions --pipeline-name "$PIPELINE" --region "$REGION" \
    --query "actionExecutionDetails[?stageName=='Source'] | [0].output.executionResult.externalExecutionSummary" \
    --output text)

ATTACHED=$(aws iam list-attached-role-policies --role-name "$GLUE_ROLE" --region "$REGION" \
    --query "AttachedPolicies[].PolicyName" --output text)
INLINE_NAME=$(aws iam list-role-policies --role-name "$GLUE_ROLE" --region "$REGION" \
    --query "PolicyNames[0]" --output text)
INLINE_DOC=$(aws iam get-role-policy --role-name "$GLUE_ROLE" --policy-name "$INLINE_NAME" --region "$REGION" \
    --query "PolicyDocument" --output json)
INLINE_ACTIONS=$(echo "$INLINE_DOC" | python3 -c "import sys,json;d=json.load(sys.stdin);print(' '.join(sorted({a for s in d['Statement'] for a in (s['Action'] if isinstance(s['Action'],list) else [s['Action']])})))")

FUNC_URL=$(aws lambda get-function --function-name "$LAMBDA" --region "$REGION" \
    --query "Code.Location" --output text)
TMPZIP=$(mktemp)
curl -s "$FUNC_URL" -o "$TMPZIP"
LAUNCHER_SRC=$(python3 -c "import zipfile,sys;z=zipfile.ZipFile('$TMPZIP');print(z.read('index.py').decode())")
STARTS_JOB=$(echo "$LAUNCHER_SRC" | grep -c "start_job_run" || true)
REPORTS_SUCCESS=$(echo "$LAUNCHER_SRC" | grep -c "put_job_success_result" || true)
POLLS=$(echo "$LAUNCHER_SRC" | grep -c "get_job_run" || true)

LOG_GROUPS=$(aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/${LAMBDA}" --region "$REGION" \
    --query "length(logGroups)" --output text)

cat > "$OUT" <<EOF
What is blocking the pipeline right now

The Source action of pipeline ${PIPELINE} is configured with Provider=${PROVIDER} and BranchName=${BRANCH}, pointing at the CodeCommit repository ${REPO}. That repository currently has ${BRANCH_COUNT} branches: the stack created the repo but never seeded it with any code, so there is no main branch and no commits at all. The pipeline has only ${EXEC_COUNT} execution in its history (the one CloudFormation kicked off automatically when the stack was first deployed), and its status is ${LAST_EXEC} — it failed at the Source stage with the message "${SOURCE_ERR}". CodePipeline re-triggers a CodeCommit source only on a push to the configured branch, so until someone pushes an initial commit on a main branch, the pipeline will never start again on its own. That is why there are zero Glue job runs, an empty artifact bucket, and no Lambda log group for the launcher (describe-log-groups for /aws/lambda/${LAMBDA} returns ${LOG_GROUPS}) — none of the downstream work has ever been reached.

What else is broken in the deploy path (latent until code is pushed)

Two further problems sit between the Source stage and a working Glue run, and neither will surface from pipeline status once the repo is seeded:

1. Fire-and-forget launcher. The launcher Lambda that implements the Deploy action, ${LAMBDA}, calls start_job_run against Glue and then immediately calls put_job_success_result back to CodePipeline, with no get_job_run polling in between (its index.py has ${STARTS_JOB} start_job_run and ${REPORTS_SUCCESS} put_job_success_result call, and ${POLLS} get_job_run calls). The Deploy stage will report SUCCESS the instant the Glue job is accepted, regardless of whether the Glue job itself fails, times out, or produces garbage. Pipeline green will not mean ETL green.

2. Under-privileged Glue worker role. The Glue worker role passed in the launcher's UserParameters alongside the Glue job ${GLUE_JOB} is ${GLUE_ROLE}. It has no AWSGlueServiceRole managed policy attached (list-attached-role-policies returns: ${ATTACHED:-none}). Its single inline policy (${INLINE_NAME}) grants only these actions: ${INLINE_ACTIONS} — that is glue:CreateJob/StartJobRun on the job, KMS on the pipeline key, and S3 read/write on the artifact bucket. There are no logs:CreateLogGroup/CreateLogStream/PutLogEvents permissions anywhere on that role, and no cloudwatch:PutMetricData. The two glue:* actions are caller-side actions that belong on the launcher Lambda, not on the worker role. Once the repo is seeded and the Lambda fires, the Glue job will start, then fail when it tries to write to its CloudWatch log group, and because of the fire-and-forget launcher above the pipeline will still report Deploy SUCCESS — the only real failure signal being the JobRunState on the Glue job.

Fixes to pull into the same PR

1. Seed the repository ${REPO} with an initial commit on a main branch that includes the ETL script, so the Source action can resolve and the pipeline can start.
2. Change the launcher Lambda ${LAMBDA} to poll get_job_run (or use the CodePipeline Lambda continuation token) and only report success once the Glue job actually succeeds.
3. Attach the AWSGlueServiceRole managed policy (or at minimum the necessary logs:* / cloudwatch:PutMetricData permissions) to the Glue worker role ${GLUE_ROLE}.
EOF
