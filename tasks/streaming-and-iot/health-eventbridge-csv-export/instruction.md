Build a pipeline that captures `aws.health` events on the pre-deployed custom event bus `{{streaming-and-iot-eventbridge-evbhx72k1-us-east-1-EventBusName}}` and writes each event's `detail` as a JSON object to S3 bucket `{{streaming-and-iot-eventbridge-evbhx72k1-us-east-1-ExportBucketName}}`. Use the pre-deployed Lambda execution role `{{streaming-and-iot-eventbridge-evbhx72k1-us-east-1-HealthRoleName}}`.

Scope the Lambda's invoke permission to that EventBridge rule specifically (the rule's ARN as the permission's source), so only that rule can invoke the function.

IMPORTANT: Write your final prose answer to `/logs/agent/agent-output.txt`.

Additionally, write `/logs/agent/agent-output.json` containing exactly:

```json
{
  "lambda_function_name": "the name of the Lambda function you created",
  "rule_name": "the name of the EventBridge rule you created"
}
```
