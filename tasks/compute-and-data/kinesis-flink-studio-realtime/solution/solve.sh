#!/bin/bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
APP_NAME="${STUDIO_APP_NAME:-flink-studio-realtime-analytics}"
ROLE_NAME="${STUDIO_ROLE_NAME:-KinesisAnalyticsStudioRole}"
GLUE_DB="${STUDIO_GLUE_DB:-flink_studio_db}"
OUT=/logs/agent/agent-output.txt
OUT_JSON=/logs/agent/agent-output.json

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

aws iam create-role --role-name "$ROLE_NAME" \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"kinesisanalytics.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name studio-access \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["kinesis:*","glue:*","s3:*","logs:*","cloudwatch:*"],"Resource":"*"}]}'

ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

aws glue create-database --region "$REGION" \
  --database-input "{\"Name\":\"${GLUE_DB}\"}"

CONFIG="{\"FlinkApplicationConfiguration\":{\"ParallelismConfiguration\":{\"ConfigurationType\":\"CUSTOM\",\"Parallelism\":1,\"ParallelismPerKPU\":1,\"AutoScalingEnabled\":false}},\"ZeppelinApplicationConfiguration\":{\"MonitoringConfiguration\":{\"LogLevel\":\"INFO\"},\"CatalogConfiguration\":{\"GlueDataCatalogConfiguration\":{\"DatabaseARN\":\"arn:aws:glue:${REGION}:${ACCOUNT_ID}:database/${GLUE_DB}\"}}}}"

sleep 15

aws kinesisanalyticsv2 create-application \
  --application-name "$APP_NAME" \
  --runtime-environment "ZEPPELIN-FLINK-3_0" \
  --application-mode "INTERACTIVE" \
  --service-execution-role "$ROLE_ARN" \
  --application-configuration "$CONFIG" \
  --region "$REGION"

mkdir -p "$(dirname "$OUT")"
printf '{"studio_notebook_application_name": "%s"}\n' "$APP_NAME" > "$OUT_JSON"
echo "Done." > "$OUT"
