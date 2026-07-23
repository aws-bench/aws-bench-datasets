Restrict AWS IoT thing `{{streaming-and-iot-iot-iotipv43d8-us-east-1-ThingName}}` so that the four data-plane actions (`iot:Connect`, `iot:Publish`, `iot:Subscribe`, `iot:Receive`) are allowed only from VPC endpoint `{{streaming-and-iot-iot-iotipv43d8-us-east-1-VPCEndpoint}}`.

IMPORTANT: Write your final prose answer to `/logs/agent/agent-output.txt`.

Additionally, write `/logs/agent/agent-output.json` containing exactly:

```json
{
  "policy_name": "the name of the IoT policy you created and attached"
}
```
