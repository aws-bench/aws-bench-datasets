#!/bin/bash
# Reference solution for enqueue-order-event.
# Sends the confirmation message with the routing attribute and records the
# returned MessageId. Honors AWS_ENDPOINT_URL (moto or real AWS).
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
QUEUE_URL="${QUEUE_URL:?QUEUE_URL is not set}"
OUT=/logs/agent/agent-output.txt

ENDPOINT_ARGS=()
if [ -n "${AWS_ENDPOINT_URL:-}" ]; then
    ENDPOINT_ARGS=(--endpoint-url "$AWS_ENDPOINT_URL")
fi

MESSAGE_ID="$(aws sqs send-message \
    --queue-url "$QUEUE_URL" \
    --message-body '{"orderId": "ord-1001", "action": "CONFIRM"}' \
    --message-attributes 'orderId={StringValue=ord-1001,DataType=String}' \
    --region "$REGION" "${ENDPOINT_ARGS[@]}" \
    --query MessageId --output text)"

mkdir -p "$(dirname "$OUT")"
cat >/logs/agent/agent-output.json <<EOF
{
  "message_id": "$MESSAGE_ID",
  "order_id": "ord-1001"
}
EOF
echo "Sent CONFIRM for ord-1001 (MessageId $MESSAGE_ID)." >"$OUT"
echo "Wrote $OUT"
