In S3 bucket `{{streaming-and-iot-s3-etlcsv9q2-us-east-1-ETLBucketName}}`, set up automatic conversion of CSV files dropped under `raw/` to `.xlsx` files written under the `{{streaming-and-iot-s3-etlcsv9q2-us-east-1-SomeFolderName}}` prefix. Three CSVs are pre-seeded under `raw/` and must end up converted by the time you finish.

IMPORTANT: Write your final prose answer to `/logs/agent/agent-output.txt`.

Additionally, write `/logs/agent/agent-output.json` containing exactly:

```json
{
  "lambda_function_name": "the name of the Lambda function you created"
}
```
