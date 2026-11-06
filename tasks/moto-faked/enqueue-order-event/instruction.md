Downstream fulfillment is waiting on the confirmation for order `ord-1001`.
Send one message to {{moto-faked-sqs-orders-us-east-1-OrderQueueUrl}} with:

- Body (exact JSON, no extra fields):
  `{"orderId": "ord-1001", "action": "CONFIRM"}`
- Message attribute `orderId` (String) = `ord-1001`, so the consumer can
  route without parsing the body.

Do not delete or purge anything; just send the message.

IMPORTANT: Write your final prose answer to `/logs/agent/agent-output.txt`.

Additionally, write `/logs/agent/agent-output.json` containing exactly:

```json
{
  "message_id": "the MessageId returned by the send call",
  "order_id": "ord-1001"
}
```
