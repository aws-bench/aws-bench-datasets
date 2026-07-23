#!/bin/bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
EVENT_BUS_NAME="${EVENT_BUS_NAME}"
EXPORT_BUCKET="${EXPORT_BUCKET}"
HEALTH_ROLE_NAME="${HEALTH_ROLE_NAME}"
OUT=/logs/agent/agent-output.json

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${HEALTH_ROLE_NAME}"
FUNCTION_NAME="health-event-exporter-${ACCOUNT_ID: -6}"
RULE_NAME="health-events-capture-rule-${ACCOUNT_ID: -6}"

WORKDIR=$(mktemp -d)
cat > "${WORKDIR}/lambda_function.py" <<'EOF'
import json
import os
import uuid
from datetime import datetime

import boto3

s3 = boto3.client("s3")
BUCKET = os.environ["BUCKET_NAME"]


def handler(event, context):
    detail = event.get("detail", {})
    key = f"health-events/{datetime.utcnow().strftime('%Y/%m/%d')}/{uuid.uuid4()}.json"
    s3.put_object(
        Bucket=BUCKET,
        Key=key,
        Body=json.dumps(detail),
        ContentType="application/json",
    )
    return {"statusCode": 200, "key": key}
EOF
(cd "$WORKDIR" && zip -q lambda.zip lambda_function.py)

aws lambda create-function \
  --function-name "$FUNCTION_NAME" \
  --runtime python3.12 \
  --role "$ROLE_ARN" \
  --handler lambda_function.handler \
  --zip-file "fileb://${WORKDIR}/lambda.zip" \
  --environment "Variables={BUCKET_NAME=${EXPORT_BUCKET}}" \
  --region "$REGION"

aws lambda wait function-active --function-name "$FUNCTION_NAME" --region "$REGION"

FUNCTION_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}"

RULE_ARN=$(aws events put-rule \
  --name "$RULE_NAME" \
  --event-bus-name "$EVENT_BUS_NAME" \
  --event-pattern '{"source": ["aws.health"]}' \
  --state ENABLED \
  --region "$REGION" \
  --query 'RuleArn' --output text)

aws lambda add-permission \
  --function-name "$FUNCTION_NAME" \
  --statement-id eventbridge-health-events \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn "$RULE_ARN" \
  --region "$REGION"

aws events put-targets \
  --rule "$RULE_NAME" \
  --event-bus-name "$EVENT_BUS_NAME" \
  --targets "[{\"Id\": \"lambda-exporter\", \"Arn\": \"${FUNCTION_ARN}\"}]" \
  --region "$REGION"

mkdir -p "$(dirname "$OUT")"
printf '{"lambda_function_name": "%s", "rule_name": "%s"}\n' "$FUNCTION_NAME" "$RULE_NAME" > "$OUT"
echo "Done." > /logs/agent/agent-output.txt
