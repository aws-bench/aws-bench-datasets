#!/bin/bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
BUCKET="${EXPECTED_LOG_BUCKET}"
DB="${ATHENA_DATABASE:-cloudfront_logs}"
TABLE="${ATHENA_TABLE:-cloudfront_access_logs}"
OUT=/logs/agent/agent-output.txt

aws glue create-database --region "$REGION" \
  --database-input "{\"Name\": \"${DB}\", \"Description\": \"Database for CloudFront distribution logs\"}"

aws glue create-table --region "$REGION" --database-name "$DB" --table-input "{
  \"Name\": \"${TABLE}\",
  \"Description\": \"CloudFront access logs\",
  \"TableType\": \"EXTERNAL_TABLE\",
  \"Parameters\": {\"skip.header.line.count\": \"2\", \"EXTERNAL\": \"TRUE\"},
  \"StorageDescriptor\": {
    \"Columns\": [
      {\"Name\": \"date\", \"Type\": \"date\"},
      {\"Name\": \"time\", \"Type\": \"string\"},
      {\"Name\": \"x_edge_location\", \"Type\": \"string\"},
      {\"Name\": \"sc_bytes\", \"Type\": \"bigint\"},
      {\"Name\": \"c_ip\", \"Type\": \"string\"},
      {\"Name\": \"cs_method\", \"Type\": \"string\"},
      {\"Name\": \"cs_host\", \"Type\": \"string\"},
      {\"Name\": \"cs_uri_stem\", \"Type\": \"string\"},
      {\"Name\": \"sc_status\", \"Type\": \"int\"},
      {\"Name\": \"cs_referer\", \"Type\": \"string\"},
      {\"Name\": \"cs_user_agent\", \"Type\": \"string\"},
      {\"Name\": \"cs_uri_query\", \"Type\": \"string\"},
      {\"Name\": \"cs_cookie\", \"Type\": \"string\"},
      {\"Name\": \"x_edge_result_type\", \"Type\": \"string\"},
      {\"Name\": \"x_edge_request_id\", \"Type\": \"string\"},
      {\"Name\": \"x_host_header\", \"Type\": \"string\"},
      {\"Name\": \"cs_protocol\", \"Type\": \"string\"},
      {\"Name\": \"cs_bytes\", \"Type\": \"bigint\"},
      {\"Name\": \"time_taken\", \"Type\": \"double\"},
      {\"Name\": \"x_forwarded_for\", \"Type\": \"string\"},
      {\"Name\": \"ssl_protocol\", \"Type\": \"string\"},
      {\"Name\": \"ssl_cipher\", \"Type\": \"string\"},
      {\"Name\": \"x_edge_response_result_type\", \"Type\": \"string\"},
      {\"Name\": \"cs_protocol_version\", \"Type\": \"string\"},
      {\"Name\": \"fle_status\", \"Type\": \"string\"},
      {\"Name\": \"fle_encrypted_fields\", \"Type\": \"string\"},
      {\"Name\": \"c_port\", \"Type\": \"int\"},
      {\"Name\": \"time_to_first_byte\", \"Type\": \"double\"},
      {\"Name\": \"x_edge_detailed_result_type\", \"Type\": \"string\"},
      {\"Name\": \"sc_content_type\", \"Type\": \"string\"},
      {\"Name\": \"sc_content_len\", \"Type\": \"bigint\"},
      {\"Name\": \"sc_range_start\", \"Type\": \"bigint\"},
      {\"Name\": \"sc_range_end\", \"Type\": \"bigint\"}
    ],
    \"Location\": \"s3://${BUCKET}/\",
    \"InputFormat\": \"org.apache.hadoop.mapred.TextInputFormat\",
    \"OutputFormat\": \"org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat\",
    \"SerdeInfo\": {\"SerializationLibrary\": \"org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe\", \"Parameters\": {\"field.delim\": \"\t\"}}
  }
}"

mkdir -p "$(dirname "$OUT")"
printf '{\n  "athenaDatabaseName": "%s",\n  "athenaTableName": "%s"\n}\n' "$DB" "$TABLE" > /logs/agent/agent-output.json
echo "Done." > "$OUT"
