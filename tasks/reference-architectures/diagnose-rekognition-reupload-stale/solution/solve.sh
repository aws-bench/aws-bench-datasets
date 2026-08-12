#!/bin/bash
set -euo pipefail

REGION="us-east-1"
BUCKET_NAME="${BUCKET_NAME}"
FUNCTION_NAME="${FUNCTION_NAME}"
TABLE_NAME="${TABLE_NAME}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

NOTIF=$(aws s3api get-bucket-notification-configuration --bucket "$BUCKET_NAME" --region "$REGION" \
    --query "LambdaFunctionConfigurations[].[join(',',Events),Filter.Key.FilterRules[?Name=='Suffix'].Value | [0],LambdaFunctionArn]" \
    --output text)
CONFIG_COUNT=$(printf '%s\n' "$NOTIF" | grep -c .)
EVENTS=$(printf '%s\n' "$NOTIF" | awk '{print $1}' | sort -u | paste -sd, -)
SUFFIXES=$(printf '%s\n' "$NOTIF" | awk '{print $2}' | paste -sd' ' -)
TARGET_ARN=$(printf '%s\n' "$NOTIF" | awk '{print $3}' | sort -u | head -1)

VERSIONING=$(aws s3api get-bucket-versioning --bucket "$BUCKET_NAME" --region "$REGION" --query "Status" --output text)

CODE_URL=$(aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" --query "Code.Location" --output text)
WORKDIR=$(mktemp -d)
curl -s -o "$WORKDIR/code.zip" "$CODE_URL"
unzip -o -q "$WORKDIR/code.zip" -d "$WORKDIR"
HANDLER=$(cat "$WORKDIR"/index.*js)
MAX_LABELS=$(printf '%s\n' "$HANDLER" | grep -oE 'MaxLabels: *[0-9]+' | grep -oE '[0-9]+')
MIN_CONFIDENCE=$(printf '%s\n' "$HANDLER" | grep -oE 'MinConfidence: *[0-9]+' | grep -oE '[0-9]+')
CONDITION=$(printf '%s\n' "$HANDLER" | grep -oE "ConditionExpression: *'[^']*'" | grep -oE "attribute_not_exists\([a-z_]+\)")

# Observe the symptom rather than only reading configuration: the stored row and
# the exception the handler swallowed.
STORED_LABELS=$(aws dynamodb get-item --table-name "$TABLE_NAME" --region "$REGION" \
    --key '{"image_name":{"S":"alpha.jpg"}}' --consistent-read \
    --query "Item.labels.S" --output text)
# --no-paginate would still return only the first page's events; let the CLI walk
# every page and count the matches itself, because the matching event does not
# necessarily land on page one.
COND_EVENTS=$(aws logs filter-log-events --region "$REGION" \
    --log-group-name "/aws/lambda/${FUNCTION_NAME}" \
    --filter-pattern '"ConditionalCheckFailedException"' \
    --query "events[].eventId" --output text | tr '\t' '\n' | grep -c . || true)

DDB=$(aws dynamodb describe-table --table-name "$TABLE_NAME" --region "$REGION" \
    --query "Table.[BillingModeSummary.BillingMode,ProvisionedThroughput.ReadCapacityUnits,ProvisionedThroughput.WriteCapacityUnits]" \
    --output text)
BILLING=$(printf '%s' "$DDB" | awk '{print $1}')
RCU=$(printf '%s' "$DDB" | awk '{print $2}')
WCU=$(printf '%s' "$DDB" | awk '{print $3}')

cat > "$OUT" <<EOF
The S3 event is firing; the team's assumption that the event never fired and ${FUNCTION_NAME} never ran is wrong. Bucket ${BUCKET_NAME} has ${CONFIG_COUNT} LambdaFunctionConfigurations for ${EVENTS}, filtered by suffix ${SUFFIXES}, all targeting ${TARGET_ARN} (${FUNCTION_NAME}). Bucket versioning status is "${VERSIONING}" (not enabled), so the second put overwrites alpha.jpg under the same key and still emits an ObjectCreated event that invokes the function.

The Lambda runs and calls rekognition.DetectLabels on the new object bytes (MaxLabels ${MAX_LABELS}, MinConfidence ${MIN_CONFIDENCE}), so the Rekognition cost is incurred on every re-upload. The real bug is what the handler does next: its putItem against table ${TABLE_NAME} is issued with ConditionExpression ${CONDITION}, i.e. it requires that the primary key image_name does not already exist. Because the alpha.jpg row was written by the first upload, the second putItem fails with ConditionalCheckFailedException.

The handler wraps that putItem in a try/catch that only logs the error (console.log(err)) and then returns normally, so the invocation exits as a success. That is why Lambda Invocations and Errors look clean, S3 shows successful delivery, and the DynamoDB row for alpha.jpg still contains the old labels: reading the row back now returns "${STORED_LABELS}", written by the first upload. The failure is visible only in CloudWatch Logs for ${FUNCTION_NAME}, where ${COND_EVENTS} ConditionalCheckFailedException event(s) are printed.

Diagnosis steps: check the bucket's notification configuration and versioning status (event fires, no versioning); confirm the Lambda's Invocations metric shows the re-upload invocation with no Errors; then read the function's CloudWatch Logs, where the ConditionalCheckFailedException on the conditional putItem appears.

Fix: remove the ${CONDITION} condition from the put, or switch to updateItem, so that re-uploads overwrite the labels instead of being silently rejected.

Secondary note: table ${TABLE_NAME} is deployed as PROVISIONED with ${RCU} RCU / ${WCU} WCU (BillingModeSummary is "${BILLING}", i.e. no on-demand), so sustained re-uploads will throttle rather than auto-scale.
EOF
