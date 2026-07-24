Create an AWS AppStream 2.0 stack in us-east-1 with create-stack that has a VPC endpoint for streaming. The AppStream stack needs to have access endpoints configured for streaming through the VPC endpoint.

IMPORTANT: Write your final prose answer to `/logs/agent/agent-output.txt`.

Additionally, write `/logs/agent/agent-output.json` containing exactly:

```json
{
  "appstream_stack_name": "the Name of the AppStream 2.0 stack the agent created",
  "vpc_endpoint_id": "the vpce-... ID of the AppStream STREAMING VPC endpoint configured on the stack"
}
```
