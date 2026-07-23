#!/bin/bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
KINESIS_STREAM_NAME="${KINESIS_STREAM_NAME}"
S3_SINK_BUCKET="${S3_SINK_BUCKET}"
FIREHOSE_ROLE_NAME="${FIREHOSE_ROLE_NAME}"
GLUE_DATABASE="${GLUE_DATABASE:-iceberg_db}"
GLUE_TABLE="${GLUE_TABLE:-firehose_iceberg_table}"
DELIVERY_STREAM="${DELIVERY_STREAM:-bench-firehose-iceberg}"
OUT=/logs/agent/agent-output.json

ACCOUNT=$(aws sts get-caller-identity --query Account --output text --region "$REGION")
KINESIS_ARN="arn:aws:kinesis:${REGION}:${ACCOUNT}:stream/${KINESIS_STREAM_NAME}"
ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/${FIREHOSE_ROLE_NAME}"
BUCKET_ARN="arn:aws:s3:::${S3_SINK_BUCKET}"
CATALOG_ARN="arn:aws:glue:${REGION}:${ACCOUNT}:catalog"

aws glue create-database --region "$REGION" \
  --database-input "{\"Name\": \"${GLUE_DATABASE}\"}"

aws glue create-table --region "$REGION" \
  --database-name "$GLUE_DATABASE" \
  --table-input "{
    \"Name\": \"${GLUE_TABLE}\",
    \"TableType\": \"EXTERNAL_TABLE\",
    \"Parameters\": {\"table_type\": \"ICEBERG\"},
    \"StorageDescriptor\": {
      \"Columns\": [
        {\"Name\": \"id\", \"Type\": \"string\"},
        {\"Name\": \"data\", \"Type\": \"string\"},
        {\"Name\": \"timestamp\", \"Type\": \"timestamp\"}
      ],
      \"Location\": \"s3://${S3_SINK_BUCKET}/iceberg/${GLUE_TABLE}/\",
      \"InputFormat\": \"org.apache.iceberg.mr.hive.HiveIcebergInputFormat\",
      \"OutputFormat\": \"org.apache.iceberg.mr.hive.HiveIcebergOutputFormat\",
      \"SerdeInfo\": {\"SerializationLibrary\": \"org.apache.iceberg.mr.hive.HiveIcebergSerDe\"}
    }
  }"

aws firehose create-delivery-stream --region "$REGION" \
  --delivery-stream-name "$DELIVERY_STREAM" \
  --delivery-stream-type KinesisStreamAsSource \
  --kinesis-stream-source-configuration "{\"KinesisStreamARN\": \"${KINESIS_ARN}\", \"RoleARN\": \"${ROLE_ARN}\"}" \
  --iceberg-destination-configuration "{
    \"RoleARN\": \"${ROLE_ARN}\",
    \"CatalogConfiguration\": {\"CatalogARN\": \"${CATALOG_ARN}\"},
    \"DestinationTableConfigurationList\": [{\"DestinationDatabaseName\": \"${GLUE_DATABASE}\", \"DestinationTableName\": \"${GLUE_TABLE}\"}],
    \"S3Configuration\": {
      \"RoleARN\": \"${ROLE_ARN}\",
      \"BucketARN\": \"${BUCKET_ARN}\",
      \"Prefix\": \"iceberg/${GLUE_TABLE}/\",
      \"ErrorOutputPrefix\": \"errors/\",
      \"BufferingHints\": {\"SizeInMBs\": 128, \"IntervalInSeconds\": 300},
      \"CompressionFormat\": \"UNCOMPRESSED\"
    },
    \"BufferingHints\": {\"SizeInMBs\": 128, \"IntervalInSeconds\": 300}
  }"

mkdir -p "$(dirname "$OUT")"
printf '{"delivery_stream_name": "%s", "glue_database_name": "%s", "glue_table_name": "%s"}\n' \
  "$DELIVERY_STREAM" "$GLUE_DATABASE" "$GLUE_TABLE" > "$OUT"
echo "Done." > /logs/agent/agent-output.txt
