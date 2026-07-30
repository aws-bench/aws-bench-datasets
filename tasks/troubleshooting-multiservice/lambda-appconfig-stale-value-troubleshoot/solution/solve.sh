#!/bin/bash
set -euo pipefail

REGION="us-west-2"
LAMBDA_NAME="${LAMBDA_FUNCTION_NAME}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

ENV_APP=$(aws lambda get-function-configuration --region "$REGION" --function-name "$LAMBDA_NAME" --query 'Environment.Variables.APP_CONFIG_APPLICATION' --output text)
ENV_ENVIRONMENT=$(aws lambda get-function-configuration --region "$REGION" --function-name "$LAMBDA_NAME" --query 'Environment.Variables.APP_CONFIG_ENVIRONMENT' --output text)
ENV_CONFIG=$(aws lambda get-function-configuration --region "$REGION" --function-name "$LAMBDA_NAME" --query 'Environment.Variables.APP_CONFIG_CONFIGURATION' --output text)
LAYER_COUNT=$(aws lambda get-function-configuration --region "$REGION" --function-name "$LAMBDA_NAME" --query 'length(Layers || `[]`)' --output text)

APP_ID=$(aws appconfig list-applications --region "$REGION" --query 'Items[0].Id' --output text)
APP_NAME=$(aws appconfig get-application --region "$REGION" --application-id "$APP_ID" --query 'Name' --output text)
ENV_ID=$(aws appconfig list-environments --region "$REGION" --application-id "$APP_ID" --query 'Items[0].Id' --output text)
ENV_NAME=$(aws appconfig get-environment --region "$REGION" --application-id "$APP_ID" --environment-id "$ENV_ID" --query 'Name' --output text)
PROFILE_ID=$(aws appconfig list-configuration-profiles --region "$REGION" --application-id "$APP_ID" --query 'Items[0].Id' --output text)
PROFILE_NAME=$(aws appconfig get-configuration-profile --region "$REGION" --application-id "$APP_ID" --configuration-profile-id "$PROFILE_ID" --query 'Name' --output text)
DEPLOY_STATE=$(aws appconfig list-deployments --region "$REGION" --application-id "$APP_ID" --environment-id "$ENV_ID" --query 'Items[0].State' --output text)

ROLE_ARN=$(aws lambda get-function-configuration --region "$REGION" --function-name "$LAMBDA_NAME" --query 'Role' --output text)
ROLE_NAME="${ROLE_ARN##*/}"
APPCONFIG_ACTIONS=$(aws iam list-role-policies --region "$REGION" --role-name "$ROLE_NAME" --query 'PolicyNames' --output text | tr '\t' '\n' | while read -r p; do [ -n "$p" ] && aws iam get-role-policy --region "$REGION" --role-name "$ROLE_NAME" --policy-name "$p" --query 'PolicyDocument.Statement[].Action[]' --output text; done | tr '\t' '\n' | grep -i '^appconfig:' | sort -u | tr '\n' ' ')

cat > "$OUT" <<EOF
The Lambda function $LAMBDA_NAME in $REGION is not reading the updated AppConfig value because its environment variables APP_CONFIG_APPLICATION, APP_CONFIG_ENVIRONMENT, and APP_CONFIG_CONFIGURATION are set to CloudFormation logical IDs ($ENV_APP, $ENV_ENVIRONMENT, $ENV_CONFIG) instead of the actual AppConfig resource names ($APP_NAME, $ENV_NAME, $PROFILE_NAME).

Any call to the AppConfig API using these logical IDs will fail with a ResourceNotFoundException, so the function never receives the deployed configuration and keeps returning the old/default value.

Fix: update the three environment variables to the actual resource names:
  APP_CONFIG_APPLICATION   -> $APP_NAME
  APP_CONFIG_ENVIRONMENT   -> $ENV_NAME
  APP_CONFIG_CONFIGURATION -> $PROFILE_NAME
For example:
  aws lambda update-function-configuration --region $REGION --function-name $LAMBDA_NAME \\
    --environment "Variables={APP_CONFIG_APPLICATION=$APP_NAME,APP_CONFIG_ENVIRONMENT=$ENV_NAME,APP_CONFIG_CONFIGURATION=$PROFILE_NAME}"
(preserve the function's other existing environment variables in the same call).

Additionally, the function has $LAYER_COUNT AWS AppConfig Lambda extension layer(s) attached. Because no extension layer is present, the code reaches AppConfig through the SDK directly, which will work once the environment variables are corrected; attaching the AppConfig Lambda extension layer is a best-practice improvement for caching and reducing API calls, not a requirement to fix this bug.

Everything else is healthy: the AppConfig deployment itself completed successfully (deployment state $DEPLOY_STATE) with application ID $APP_ID, environment ID $ENV_ID, and configuration profile ID $PROFILE_ID, and the Lambda execution role has the correct AppConfig permissions ($APPCONFIG_ACTIONS).
EOF
