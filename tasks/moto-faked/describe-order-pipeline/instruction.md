A new teammate joins the on-call rotation next week. Write the "order-intake
pipeline" section of the team runbook: which AWS resources make up the
pipeline in us-east-1, and how does order data flow between them?

Cover all three stages:

1. Landing: S3 bucket {{moto-faked-s3-orders-us-east-1-LandingBucketName}}.
   Where do order batches land inside the bucket?
2. Buffering: SQS queue {{moto-faked-sqs-orders-us-east-1-OrderQueueUrl}}.
   What happens to a message that keeps failing to process?
3. Records: DynamoDB table {{moto-faked-ddb-orders-us-east-1-OrdersTableName}}.
   What is the table's partition key?

IMPORTANT: Write your final answer to `/logs/agent/agent-output.txt`.
