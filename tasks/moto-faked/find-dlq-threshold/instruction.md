The on-call alert "order-events DLQ growing" just fired. A teammate asks:
after how many failed processing attempts does a message on
{{moto-faked-sqs-orders-us-east-1-OrderQueueUrl}} move to the dead-letter
queue, and which DLQ does it go to?

Inspect the queue's redrive policy and answer with the exact threshold and
the exact DLQ identity. Do not change anything.

IMPORTANT: Write your final answer to `/logs/agent/agent-output.txt`.
