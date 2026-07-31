#!/bin/bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
BUCKET="${BUCKET_NAME}"
SOURCE_KEY="${SOURCE_KEY:-src/index.html}"
APP_NAME="${APP_NAME:-frontend-app}"
BRANCH="${BRANCH_NAME:-main}"
OUT=/logs/agent/agent-output.txt

WORK="$(mktemp -d)"
aws s3 cp "s3://${BUCKET}/${SOURCE_KEY}" "${WORK}/index.html" --region "$REGION"
(cd "$WORK" && zip -qr /tmp/frontend.zip .)

APP_ID="$(aws amplify create-app --name "$APP_NAME" --region "$REGION" --query app.appId --output text)"
aws amplify create-branch --app-id "$APP_ID" --branch-name "$BRANCH" --region "$REGION"

read -r JOB_ID UPLOAD_URL < <(aws amplify create-deployment --app-id "$APP_ID" --branch-name "$BRANCH" --region "$REGION" --query '[jobId,zipUploadUrl]' --output text)
curl -sSf -X PUT -T /tmp/frontend.zip "$UPLOAD_URL"
aws amplify start-deployment --app-id "$APP_ID" --branch-name "$BRANCH" --job-id "$JOB_ID" --region "$REGION"

DOMAIN="$(aws amplify get-app --app-id "$APP_ID" --region "$REGION" --query app.defaultDomain --output text)"
APP_URL="https://${BRANCH}.${DOMAIN}"

mkdir -p "$(dirname "$OUT")"
printf '{\n  "app_url": "%s"\n}\n' "$APP_URL" > /logs/agent/agent-output.json
echo "Done." > "$OUT"
