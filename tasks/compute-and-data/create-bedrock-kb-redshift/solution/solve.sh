#!/bin/bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
DB="${REDSHIFT_DB:-dev}"
WORKGROUP="${REDSHIFT_WORKGROUP}"
OUT=/logs/agent/agent-output.txt
OUT_JSON=/logs/agent/agent-output.json

WORKGROUP_ARN=$(aws redshift-serverless get-workgroup --workgroup-name "$WORKGROUP" --region "$REGION" --query 'workgroup.workgroupArn' --output text)

ROLE_NAME="BedrockExecutionRoleForKnowledgeBase-Redshift"
ROLE_ARN=$(aws iam create-role --role-name "$ROLE_NAME" \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"bedrock.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
  --query 'Role.Arn' --output text)
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name kb-inline \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["bedrock:*","redshift-serverless:*","redshift-data:*","redshift:GetClusterCredentialsWithIAM","redshift:GetClusterCredentials","sqlworkbench:*"],"Resource":"*"}]}'
sleep 15

KB_ID=$(aws bedrock-agent create-knowledge-base \
  --region "$REGION" \
  --name "redshift-kb-$(date +%s)" \
  --role-arn "$ROLE_ARN" \
  --knowledge-base-configuration "{\"type\":\"SQL\",\"sqlKnowledgeBaseConfiguration\":{\"type\":\"REDSHIFT\",\"redshiftConfiguration\":{\"storageConfigurations\":[{\"type\":\"REDSHIFT\",\"redshiftConfiguration\":{\"databaseName\":\"${DB}\"}}],\"queryEngineConfiguration\":{\"type\":\"SERVERLESS\",\"serverlessConfiguration\":{\"workgroupArn\":\"${WORKGROUP_ARN}\",\"authConfiguration\":{\"type\":\"IAM\"}}}}}}" \
  --query 'knowledgeBase.knowledgeBaseId' --output text)

aws bedrock-agent create-data-source \
  --region "$REGION" \
  --knowledge-base-id "$KB_ID" \
  --name "redshift-metadata" \
  --data-source-configuration '{"type":"REDSHIFT_METADATA"}'

mkdir -p "$(dirname "$OUT")"
printf '{"knowledge_base_id": "%s"}\n' "$KB_ID" > "$OUT_JSON"
echo "Done." > "$OUT"
