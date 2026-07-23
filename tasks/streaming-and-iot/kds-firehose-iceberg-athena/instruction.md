Build an Amazon Data Firehose delivery stream that consumes from Kinesis stream `{{streaming-and-iot-kinesis-kdsicb52e-us-east-1-KinesisStreamName}}` and lands records as Apache Iceberg in S3 bucket `{{streaming-and-iot-kinesis-kdsicb52e-us-east-1-S3BucketName}}`. Pre-deployed Firehose service role: `{{streaming-and-iot-kinesis-kdsicb52e-us-east-1-FirehoseRoleName}}`.

IMPORTANT: Write your final prose answer to `/logs/agent/agent-output.txt`.

Additionally, write `/logs/agent/agent-output.json` containing exactly:

```json
{
  "delivery_stream_name": "the name of the Firehose delivery stream you created",
  "glue_database_name": "the Glue database you created",
  "glue_table_name": "the Iceberg table you created"
}
```
