Create serverless infrastructure in us-east-1 containing a DynamoDB table that stores IP addresses with timestamps, a Lambda function to capture visitor IP addresses from a webpage, and an API Gateway API to trigger the Lambda function.

IMPORTANT: Write your final prose answer to `/logs/agent/agent-output.txt`.

Additionally, write `/logs/agent/agent-output.json` containing exactly:

```json
{
  "dynamodb_table": "the DynamoDB table name the agent created",
  "lambda_function_name": "the Lambda FunctionName the agent created",
  "apigateway_id": "the API Gateway ID (apigatewayv2 ApiId or apigateway restApiId)",
  "api_endpoint": "the fully-qualified HTTPS endpoint URL that, when called with GET, invokes the Lambda and writes a record to DynamoDB"
}
```
