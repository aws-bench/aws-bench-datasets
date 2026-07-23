#!/bin/bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
BUCKET="${CSV_BUCKET}"
OUT=/logs/agent/agent-output.txt
JSON=/logs/agent/agent-output.json
S3="s3://${BUCKET}"
OUTPUT="s3://${BUCKET}/athena-results/"

run_query() {
  local exec_id state
  exec_id=$(aws athena start-query-execution \
    --query-string "$1" \
    --work-group primary \
    --region "$REGION" \
    --result-configuration "OutputLocation=${OUTPUT}" \
    --query 'QueryExecutionId' --output text)
  for _ in $(seq 1 60); do
    state=$(aws athena get-query-execution --query-execution-id "$exec_id" \
      --region "$REGION" --query 'QueryExecution.Status.State' --output text)
    case "$state" in
      SUCCEEDED) return 0 ;;
      FAILED|CANCELLED) return 1 ;;
    esac
    sleep 2
  done
  return 1
}

make_table() {
  local db="$1" table="$2" prefix="$3"
  run_query "CREATE DATABASE IF NOT EXISTS ${db}"
  run_query "CREATE EXTERNAL TABLE IF NOT EXISTS ${db}.${table} (line string)
ROW FORMAT DELIMITED FIELDS TERMINATED BY '\t'
LOCATION '${S3}/${prefix}'
TBLPROPERTIES ('has_encrypted_data'='false', 'skip.header.line.count'='1')"
}

make_table customers customer_master data/processed/customers/
make_table sales regional_sales regions/
make_table finance budgets dept/finance/
make_table operations inventory_stock temp/inventory/
make_table products items products/
make_table orders monthly_orders monthly/

mkdir -p "$(dirname "$OUT")"
printf '{"database_name_list": ["customers", "sales", "finance", "operations", "products", "orders"]}\n' > "$JSON"
echo "Done." > "$OUT"
