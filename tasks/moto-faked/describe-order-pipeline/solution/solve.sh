#!/bin/bash
# Reference solution for describe-order-pipeline.
# Read-only: describes the three pipeline stages and writes the runbook
# section. Honors AWS_ENDPOINT_URL so it runs against moto or real AWS.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
BUCKET="${LANDING_BUCKET:?LANDING_BUCKET is not set}"
QUEUE_URL="${ORDER_QUEUE_URL:?ORDER_QUEUE_URL is not set}"
TABLE="${ORDERS_TABLE:?ORDERS_TABLE is not set}"
OUT=/logs/agent/agent-output.txt

ENDPOINT_ARGS=()
if [ -n "${AWS_ENDPOINT_URL:-}" ]; then
    ENDPOINT_ARGS=(--endpoint-url "$AWS_ENDPOINT_URL")
fi

VERSIONING="$(aws s3api get-bucket-versioning --bucket "$BUCKET" --region "$REGION" "${ENDPOINT_ARGS[@]}" --query Status --output text)"
REDRIVE_JSON="$(aws sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names All --region "$REGION" "${ENDPOINT_ARGS[@]}" --query Attributes.RedrivePolicy --output text)"
REDRIVE_MAX="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['maxReceiveCount'])" "$REDRIVE_JSON")"
DLQ_ARN="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['deadLetterTargetArn'])" "$REDRIVE_JSON")"
KEY_SCHEMA="$(aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" "${ENDPOINT_ARGS[@]}" --query 'Table.KeySchema' --output json)"

mkdir -p "$(dirname "$OUT")"
cat >"$OUT" <<EOF
Order-intake pipeline (us-east-1):

1. Landing (S3): bucket $BUCKET (versioning: $VERSIONING). Order batches
   land under the incoming/ prefix.
2. Buffering (SQS): queue $QUEUE_URL. A message that fails processing
   $REDRIVE_MAX times is moved to the dead-letter queue ($DLQ_ARN).
3. Records (DynamoDB): table $TABLE with key schema $KEY_SCHEMA.
EOF
echo "Wrote $OUT"
