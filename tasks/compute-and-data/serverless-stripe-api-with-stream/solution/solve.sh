#!/bin/bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
TABLE="${TABLE_NAME:-visitor-ip-log}"
FUNCTION="${FUNCTION_NAME:-visitor-ip-capture}"
ROLE="${ROLE_NAME:-visitor-ip-lambda-role}"
API_NAME="${API_NAME:-visitor-ip-api}"
ROUTE="${ROUTE_KEY:-GET /capture}"
ROUTE_PATH="${ROUTE_PATH:-capture}"
OUT=/logs/agent/agent-output.txt
OUT_JSON=/logs/agent/agent-output.json

ACCOUNT="$(aws sts get-caller-identity --query Account --output text --region "$REGION")"

aws dynamodb create-table --table-name "$TABLE" \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST --region "$REGION"
aws dynamodb wait table-exists --table-name "$TABLE" --region "$REGION"

aws iam create-role --role-name "$ROLE" \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name "$ROLE" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam put-role-policy --role-name "$ROLE" --policy-name dynamodb-write-policy \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"dynamodb:PutItem\"],\"Resource\":\"arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${TABLE}\"}]}"

WORK="$(mktemp -d)"
cat > "$WORK/lambda_function.py" <<PY
import json, uuid, boto3
from datetime import datetime, timezone

table = boto3.resource("dynamodb").Table("${TABLE}")

def lambda_handler(event, context):
    ip = None
    rc = event.get("requestContext", {})
    if "http" in rc:
        ip = rc["http"].get("sourceIp")
    elif "identity" in rc:
        ip = rc["identity"].get("sourceIp")
    if not ip:
        headers = event.get("headers", {}) or {}
        ip = (headers.get("x-forwarded-for", "").split(",")[0].strip() or headers.get("x-real-ip"))
    ip = ip or "unknown"
    ts = datetime.now(timezone.utc).isoformat()
    rid = str(uuid.uuid4())
    table.put_item(Item={"id": rid, "ip_address": ip, "timestamp": ts})
    return {"statusCode": 200, "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"message": "IP address recorded", "ip": ip, "timestamp": ts, "id": rid})}
PY
(cd "$WORK" && zip -q lambda_function.zip lambda_function.py)

ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/${ROLE}"
sleep 15
aws lambda create-function --function-name "$FUNCTION" --runtime python3.12 \
  --role "$ROLE_ARN" --handler lambda_function.lambda_handler \
  --zip-file "fileb://$WORK/lambda_function.zip" --timeout 10 --memory-size 128 \
  --region "$REGION"
aws lambda wait function-active-v2 --function-name "$FUNCTION" --region "$REGION"
FUNCTION_ARN="arn:aws:lambda:${REGION}:${ACCOUNT}:function:${FUNCTION}"

API_ID="$(aws apigatewayv2 create-api --name "$API_NAME" --protocol-type HTTP \
  --region "$REGION" --query ApiId --output text)"

INTEGRATION_ID="$(aws apigatewayv2 create-integration --api-id "$API_ID" \
  --integration-type AWS_PROXY --integration-uri "$FUNCTION_ARN" \
  --payload-format-version 2.0 --region "$REGION" --query IntegrationId --output text)"

aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$ROUTE" \
  --target "integrations/${INTEGRATION_ID}" --region "$REGION"

aws apigatewayv2 create-stage --api-id "$API_ID" --stage-name '$default' \
  --auto-deploy --region "$REGION"

aws lambda add-permission --function-name "$FUNCTION" --statement-id apigateway-invoke \
  --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT}:${API_ID}/*/*/${ROUTE_PATH}" \
  --region "$REGION"

API_ENDPOINT="https://${API_ID}.execute-api.${REGION}.amazonaws.com/${ROUTE_PATH}"

sleep 10

mkdir -p "$(dirname "$OUT")"
cat > "$OUT_JSON" <<JSON
{
  "dynamodb_table": "${TABLE}",
  "lambda_function_name": "${FUNCTION}",
  "apigateway_id": "${API_ID}",
  "api_endpoint": "${API_ENDPOINT}"
}
JSON

echo "Done." > "$OUT"
