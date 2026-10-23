#!/bin/bash
# Reference solution for find-dlq-threshold.
# Read-only: reads the queue's redrive policy and writes the diagnosis.
# Honors AWS_ENDPOINT_URL so it runs against moto or real AWS.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
QUEUE_URL="${ORDER_QUEUE_URL:?ORDER_QUEUE_URL is not set}"
OUT=/logs/agent/agent-output.txt

ENDPOINT_ARGS=()
if [ -n "${AWS_ENDPOINT_URL:-}" ]; then
    ENDPOINT_ARGS=(--endpoint-url "$AWS_ENDPOINT_URL")
fi

REDRIVE_JSON="$(aws sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names All --region "$REGION" "${ENDPOINT_ARGS[@]}" --query Attributes.RedrivePolicy --output text)"
REDRIVE_MAX="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['maxReceiveCount'])" "$REDRIVE_JSON")"
DLQ_ARN="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['deadLetterTargetArn'])" "$REDRIVE_JSON")"

mkdir -p "$(dirname "$OUT")"
cat >"$OUT" <<EOF
Diagnosis: $QUEUE_URL moves a message to its dead-letter queue after
$REDRIVE_MAX failed receives (maxReceiveCount=$REDRIVE_MAX). The DLQ is
$DLQ_ARN.
EOF
echo "Wrote $OUT"
