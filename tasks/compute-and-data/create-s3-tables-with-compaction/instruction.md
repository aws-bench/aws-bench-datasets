Create two S3 tables (one with sort compaction and one without) within an S3 table bucket in us-east-1 with some sample data to verify why sort compaction performance varies significantly for different user IDs when using Athena queries.

IMPORTANT: Write your final prose answer to `/logs/agent/agent-output.txt`.

Additionally, write `/logs/agent/agent-output.json` containing exactly:
```json
{"s3_table_bucket_name": "<name>", "s3_table_name_with_compaction": "<name>", "s3_table_name_without_compaction": "<name>"}
```
