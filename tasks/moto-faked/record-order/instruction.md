Order `ord-1001` cleared fulfillment. Write its record to the DynamoDB table
{{moto-faked-ddb-orders-us-east-1-OrdersTableName}} with exactly these
attributes (no extra attributes):

- `orderId` (string partition key): `ord-1001`
- `status` (string): `PENDING`
- `total` (number): `2500`

Do not touch any other item.

IMPORTANT: Write your final prose answer to `/logs/agent/agent-output.txt`.

Additionally, write `/logs/agent/agent-output.json` containing exactly:

```json
{
  "order_id": "ord-1001",
  "status": "PENDING"
}
```
