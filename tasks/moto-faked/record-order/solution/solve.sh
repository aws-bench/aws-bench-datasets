#!/bin/bash
# Reference solution for record-order.
# Writes the ord-1001 item and both agent outputs.
# Honors AWS_ENDPOINT_URL so it runs against moto or real AWS.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
TABLE="${TABLE_NAME:?TABLE_NAME is not set}"
OUT=/logs/agent/agent-output.txt

ENDPOINT_ARGS=()
if [ -n "${AWS_ENDPOINT_URL:-}" ]; then
    ENDPOINT_ARGS=(--endpoint-url "$AWS_ENDPOINT_URL")
fi

aws dynamodb put-item \
    --table-name "$TABLE" \
    --item '{"orderId": {"S": "ord-1001"}, "status": {"S": "PENDING"}, "total": {"N": "2500"}}' \
    --region "$REGION" "${ENDPOINT_ARGS[@]}" >/dev/null

mkdir -p "$(dirname "$OUT")"
cat >/logs/agent/agent-output.json <<'EOF'
{
  "order_id": "ord-1001",
  "status": "PENDING"
}
EOF
echo "Recorded ord-1001 as PENDING with total 2500." >"$OUT"
echo "Wrote $OUT"
