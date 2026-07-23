#!/bin/bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
BUCKET="${BUCKET_NAME:-sort-compaction-demo}"
NAMESPACE="${NAMESPACE:-analytics}"
TABLE_WITH="${TABLE_WITH:-user_events_with_sort_compaction}"
TABLE_WITHOUT="${TABLE_WITHOUT:-user_events_without_compaction}"
OUT=/logs/agent/agent-output.txt
OUT_JSON=/logs/agent/agent-output.json

ARN=$(aws s3tables create-table-bucket --name "$BUCKET" --region "$REGION" --query 'arn' --output text)

aws s3tables create-namespace --table-bucket-arn "$ARN" --namespace "$NAMESPACE" --region "$REGION"

SCHEMA='{"iceberg":{"schema":{"fields":[{"name":"user_id","type":"string","required":true},{"name":"event_type","type":"string","required":true},{"name":"event_timestamp","type":"long","required":true},{"name":"session_id","type":"string","required":false}]}}}'

aws s3tables create-table --table-bucket-arn "$ARN" --namespace "$NAMESPACE" --name "$TABLE_WITH" --format ICEBERG --metadata "$SCHEMA" --region "$REGION"
aws s3tables create-table --table-bucket-arn "$ARN" --namespace "$NAMESPACE" --name "$TABLE_WITHOUT" --format ICEBERG --metadata "$SCHEMA" --region "$REGION"

ARN="$ARN" NAMESPACE="$NAMESPACE" TABLE_WITH="$TABLE_WITH" REGION="$REGION" \
uv run --quiet --with 'pyiceberg[s3tables]' --with boto3 python3 - <<'PY'
import os

import boto3
from pyiceberg.catalog.rest import RestCatalog
from pyiceberg.transforms import IdentityTransform

region = os.environ["REGION"]
bucket_arn = os.environ["ARN"]
namespace = os.environ["NAMESPACE"]
table = os.environ["TABLE_WITH"]

creds = boto3.Session().get_credentials().get_frozen_credentials()
catalog = RestCatalog(
    name="s3tables",
    **{
        "uri": f"https://s3tables.{region}.amazonaws.com/iceberg",
        "warehouse": bucket_arn,
        "rest.sigv4-enabled": "true",
        "rest.signing-region": region,
        "rest.signing-name": "s3tables",
        "rest.access-key-id": creds.access_key,
        "rest.secret-access-key": creds.secret_key,
        "rest.session-token": creds.token,
        "s3.region": region,
    },
)

t = catalog.load_table(f"{namespace}.{table}")
with t.update_sort_order() as upd:
    upd.asc("user_id", IdentityTransform())

t = catalog.load_table(f"{namespace}.{table}")
assert t.sort_order().order_id > 0, f"sort order not applied: {t.sort_order()}"
PY

aws s3tables put-table-maintenance-configuration --table-bucket-arn "$ARN" --namespace "$NAMESPACE" --name "$TABLE_WITH" --type icebergCompaction --value '{"status":"enabled","settings":{"icebergCompaction":{"strategy":"sort"}}}' --region "$REGION"
aws s3tables put-table-maintenance-configuration --table-bucket-arn "$ARN" --namespace "$NAMESPACE" --name "$TABLE_WITHOUT" --type icebergCompaction --value '{"status":"disabled"}' --region "$REGION"

mkdir -p "$(dirname "$OUT")"
printf '{"s3_table_bucket_name": "%s", "s3_table_name_with_compaction": "%s", "s3_table_name_without_compaction": "%s"}\n' "$BUCKET" "$TABLE_WITH" "$TABLE_WITHOUT" > "$OUT_JSON"
echo "Done." > "$OUT"
