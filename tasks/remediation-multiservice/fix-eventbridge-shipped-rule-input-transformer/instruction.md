`{{remediation-multiservice-Fulfillment-5k53ncku2-us-east-1-RecordsTableName}}` shows that OrderShipped events are landing with a defaulted customer tier and SLA, while OrderPlaced and OrderReturned rows for the same order IDs record the correct values. Investigate the account, find the root cause, and make changes so newly-published OrderShipped events land with the true tier and SLA. Do not change anything unrelated to the actual fault.

Confirm the repair with a live event round-trip on the affected bus. The true payload shape cannot be reconstructed from same-named rules elsewhere or from archived envelopes.

IMPORTANT: Write your final prose answer to `/logs/agent/agent-output.txt`.
