Today's order batch must be staged for the intake pipeline. Upload it to the
landing bucket {{moto-faked-s3-orders-us-east-1-LandingBucketName}} as a
single JSON document at key `incoming/orders-2026-10-23.json`.

The document must be a JSON array with exactly these two orders (no extra
fields, no extra orders):

```json
[
  {"orderId": "ord-1001", "total": 2500, "currency": "USD"},
  {"orderId": "ord-1002", "total": 1750, "currency": "USD"}
]
```

IMPORTANT: Write your final prose answer to `/logs/agent/agent-output.txt`.

Additionally, write `/logs/agent/agent-output.json` containing exactly:

```json
{
  "s3_key": "the key you uploaded (incoming/orders-2026-10-23.json)",
  "order_count": 2
}
```
