Stand up an ECS service on the pre-deployed cluster `{{streaming-and-iot-ecs-ecsasg7m4-us-east-1-ClusterName}}` (EC2 launch type, ASG capacity provider already attached) and register it in AWS Cloud Map.

IMPORTANT: Write your final prose answer to `/logs/agent/agent-output.txt`.

Additionally, write `/logs/agent/agent-output.json` containing exactly:

```json
{
  "service_name": "the ECS service name you created",
  "namespace_name": "the Cloud Map namespace name you created",
  "cloudmap_service_name": "the Cloud Map service name you registered"
}
```
