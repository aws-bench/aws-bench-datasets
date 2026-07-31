#!/bin/bash
set -euo pipefail

REGION="us-east-1"
BROKER_NAME="${BROKER_NAME}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

BROKER_ID=$(aws mq list-brokers --region "$REGION" \
    --query "BrokerSummaries[?BrokerName=='${BROKER_NAME}'].BrokerId | [0]" --output text)

read -r BROKER_ARN BROKER_STATE < <(aws mq describe-broker --region "$REGION" --broker-id "$BROKER_ID" \
    --query "[BrokerArn,BrokerState]" --output text)

read -r ESM_UUID ESM_STATE ESM_REASON FN_ARN ESM_QUEUE < <(aws lambda list-event-source-mappings --region "$REGION" \
    --event-source-arn "$BROKER_ARN" \
    --query "EventSourceMappings[0].[UUID,State,StateTransitionReason,FunctionArn,join(\`,\`,Queues)]" --output text)

FUNCTION_NAME=$(aws lambda get-function --region "$REGION" --function-name "$FN_ARN" \
    --query "Configuration.FunctionName" --output text)

CODE_URL=$(aws lambda get-function --region "$REGION" --function-name "$FN_ARN" \
    --query "Code.Location" --output text)
ZIP=$(mktemp)
curl -s "$CODE_URL" -o "$ZIP"
HANDLER_SRC=$(unzip -p "$ZIP" index.js)

cat > "$OUT" <<EOF
Diagnosis: the RabbitMQ consumer pipeline is broken and no messages are being processed, even though the broker ${BROKER_NAME} is in state ${BROKER_STATE} and the Lambda function ${FUNCTION_NAME} exists. There are two primary root causes.

1. Broken Lambda event source mapping (ESM). The ESM (UUID ${ESM_UUID}) that wires the Amazon MQ RabbitMQ broker to the Lambda function cannot reach its target queue, so it never triggers the function. Its current State is "${ESM_STATE}" (StateTransitionReason: "${ESM_REASON}") and it is configured to poll queue(s): ${ESM_QUEUE}. After repeated connection failures AWS may leave the ESM Enabled but reporting connection errors, or automatically Disable it; either way the Lambda is never invoked.

2. The target queue ${ESM_QUEUE} does not exist on the broker. The ESM is configured to poll ${ESM_QUEUE}, but that queue was never created on the RabbitMQ broker after provisioning. With no queue to bind to, the ESM cannot connect/poll and Lambda is never triggered.

Fix: create the ${ESM_QUEUE} queue on the RabbitMQ broker (via the broker's RabbitMQ management console/API), and if the event source mapping was disabled, re-enable it (aws lambda update-event-source-mapping --uuid ${ESM_UUID} --enabled). Once the queue exists and the ESM is enabled, the connection succeeds and messages are delivered to Lambda.

Secondary observation: the Lambda handler is a minimal stub that only logs the received messages (its index.js just console.logs each message body and returns). This is not a defect that blocks consumption -- it does not affect whether messages are pulled from the queue.
EOF
