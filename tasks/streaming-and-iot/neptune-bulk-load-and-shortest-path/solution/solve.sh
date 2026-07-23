#!/bin/bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
BRIDGE="${BRIDGE_LAMBDA_NAME}"
BUCKET="${LOADER_BUCKET}"
ROLE_ARN="${LOADER_ROLE_ARN}"
OUT=/logs/agent/agent-output.json
RESP=/tmp/bridge-resp.json

invoke() {
  aws lambda invoke --region "$REGION" --function-name "$BRIDGE" \
    --cli-read-timeout 360 --cli-connect-timeout 60 \
    --cli-binary-format raw-in-base64-out --payload "$1" "$RESP"
}

invoke "{\"action\":\"start_loader\",\"source\":\"s3://${BUCKET}/graph/\",\"iam_role_arn\":\"${ROLE_ARN}\",\"format\":\"csv\"}"
LOAD_ID=$(jq -r '.body | fromjson | .payload.loadId' "$RESP")

for _ in $(seq 1 60); do
  invoke "{\"action\":\"loader_status\",\"load_id\":\"${LOAD_ID}\"}"
  STATUS=$(jq -r '.result.payload.overallStatus.status // empty' "$RESP")
  if [ "$STATUS" = "LOAD_COMPLETED" ]; then break; fi
  sleep 5
done

invoke "{\"action\":\"shortest_path\",\"from\":\"alice\",\"to\":\"eve\"}"
PATH_LENGTH=$(jq -r '.path_length' "$RESP")

mkdir -p "$(dirname "$OUT")"
printf '{"load_id": "%s", "path_length": %s}\n' "$LOAD_ID" "$PATH_LENGTH" > "$OUT"
echo "Done." > /logs/agent/agent-output.txt
