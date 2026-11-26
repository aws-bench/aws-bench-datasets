#!/bin/bash
# Reference solution for upload-order-batch.
# Uploads the exact batch document and writes both agent outputs.
# Honors AWS_ENDPOINT_URL so it runs against moto or real AWS.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
BUCKET="${BUCKET_NAME:?BUCKET_NAME is not set}"
KEY="incoming/orders-2026-10-23.json"
OUT=/logs/agent/agent-output.txt

ENDPOINT_ARGS=()
if [ -n "${AWS_ENDPOINT_URL:-}" ]; then
    ENDPOINT_ARGS=(--endpoint-url "$AWS_ENDPOINT_URL")
fi

TMP="$(mktemp)"
cat >"$TMP" <<'EOF'
[
  {"orderId": "ord-1001", "total": 2500, "currency": "USD"},
  {"orderId": "ord-1002", "total": 1750, "currency": "USD"}
]
EOF

aws s3 cp "$TMP" "s3://${BUCKET}/${KEY}" --region "$REGION" "${ENDPOINT_ARGS[@]}" >/dev/null
rm -f "$TMP"

mkdir -p "$(dirname "$OUT")"
cat >/logs/agent/agent-output.json <<EOF
{
  "s3_key": "$KEY",
  "order_count": 2
}
EOF
echo "Uploaded s3://${BUCKET}/${KEY} with 2 orders." >"$OUT"
echo "Wrote $OUT"
