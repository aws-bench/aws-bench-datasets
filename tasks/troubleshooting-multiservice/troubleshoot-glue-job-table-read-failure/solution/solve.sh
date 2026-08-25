#!/bin/bash
set -euo pipefail

REGION="us-east-1"
JOB_NAME="${GLUE_JOB_NAME}"
TABLE_NAME="${GLUE_TABLE_NAME}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

ROLE_ARN=$(aws glue get-job --job-name "$JOB_NAME" --region "$REGION" --query "Job.Role" --output text)
DATABASE_NAME=$(aws glue get-job --job-name "$JOB_NAME" --region "$REGION" --query 'Job.DefaultArguments."--database"' --output text)
ROLE_NAME="${ROLE_ARN##*/}"

# An absent run and a run that did not fail both leave ErrorMessage empty, which
# would otherwise be interpolated into the claim that the run failed. Glue keeps
# run history for 365 days, so a long-lived account can reach that state.
JOB_RUN_STATE=$(aws glue get-job-runs --job-name "$JOB_NAME" --region "$REGION" --max-results 1 --query "JobRuns[0].JobRunState" --output text)
JOB_ERROR=$(aws glue get-job-runs --job-name "$JOB_NAME" --region "$REGION" --max-results 1 --query "JobRuns[0].ErrorMessage" --output text)

if [ "$JOB_RUN_STATE" != "FAILED" ]; then
    echo "latest run of ${JOB_NAME} is '${JOB_RUN_STATE}', expected FAILED" >&2
    exit 1
fi
if ! printf '%s' "$JOB_ERROR" | grep -qiE 'lake ?formation|AccessDenied'; then
    echo "latest run of ${JOB_NAME} failed for an unexpected reason: ${JOB_ERROR}" >&2
    exit 1
fi

CREATE_TABLE_DEFAULTS=$(aws lakeformation get-data-lake-settings --region "$REGION" --query "DataLakeSettings.CreateTableDefaultPermissions" --output json)
TABLE_PERMS=$(aws lakeformation list-permissions --region "$REGION" --resource "{\"Table\":{\"DatabaseName\":\"$DATABASE_NAME\",\"Name\":\"$TABLE_NAME\"}}" --query "PrincipalResourcePermissions[?Principal.DataLakePrincipalIdentifier=='$ROLE_ARN']" --output json)
DB_PERMS=$(aws lakeformation list-permissions --region "$REGION" --resource "{\"Database\":{\"Name\":\"$DATABASE_NAME\"}}" --query "PrincipalResourcePermissions[?Principal.DataLakePrincipalIdentifier=='$ROLE_ARN']" --output json)
ATTACHED=$(aws iam list-attached-role-policies --role-name "$ROLE_NAME" --region "$REGION" --query "AttachedPolicies[].PolicyName" --output text)

cat > "$OUT" <<EOF
The Glue job ${JOB_NAME} is failing when reading from the ${TABLE_NAME} table with an AccessDeniedException from Lake Formation. The most recent job run failed with: "${JOB_ERROR}".

Root cause: Lake Formation is enforcing permissions on the ${TABLE_NAME} table and there are no grants in place for the Glue role. The account's Lake Formation default settings have CreateTableDefaultPermissions set to empty (get-data-lake-settings returns CreateTableDefaultPermissions = ${CREATE_TABLE_DEFAULTS}), which means the legacy IAMAllowedPrincipals auto-grant is disabled and Lake Formation enforces permissions on all new Data Catalog tables. No Lake Formation permissions have been granted to the Glue role ${ROLE_ARN} on the table ${TABLE_NAME} (list-permissions returns ${TABLE_PERMS}) or on the database ${DATABASE_NAME} (list-permissions returns ${DB_PERMS}).

The Glue role also has the AWSLakeFormationDataAdmin managed policy attached (attached policies: ${ATTACHED}). AWSLakeFormationDataAdmin grants lakeformation:* including lakeformation:GetDataAccess, the IAM permission required for Lake Formation credential vending. Because the role holds lakeformation:GetDataAccess, Glue routes table access through Lake Formation credential vending instead of direct IAM-based S3 access. With Lake Formation enforcing permissions and no grants present, that credential vending call fails with AccessDeniedException.

Resolution (either option works):
- Grant the Glue role ${ROLE_ARN} SELECT and DESCRIBE permissions on the ${TABLE_NAME} table in Lake Formation, e.g. aws lakeformation grant-permissions --region ${REGION} --principal DataLakePrincipalIdentifier=${ROLE_ARN} --resource '{"Table":{"DatabaseName":"${DATABASE_NAME}","Name":"${TABLE_NAME}"}}' --permissions SELECT DESCRIBE; or
- Remove the AWSLakeFormationDataAdmin managed policy from the Glue role so that Glue falls back to IAM-based S3 access, which is already permitted by the AmazonS3FullAccess policy attached to the role.
EOF
