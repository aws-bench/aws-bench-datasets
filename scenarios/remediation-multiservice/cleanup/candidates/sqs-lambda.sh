#!/bin/bash
# SQS + Lambda order-ingest cleanup. `pre` runs before the shared `cdk destroy --all`, `post` after.
set -uo pipefail

PHASE="${1:?usage: $0 pre|post}"

export AWS_PROFILE=PRIMARY
REGIONS="us-east-1"

if [ "$PHASE" = "pre" ]; then
    echo "=== pre: clear resources that block stack deletion ==="
    # Stop the traffic generator and the guardrail reconciler first: an in-flight
    # UpdateEventSourceMapping call races CloudFormation's delete of the same
    # mapping, and the ingest schedule keeps refilling queues during the delete.
    for region in $REGIONS; do
        for rule in ordpipe-ingest-schedule ordpipe-platform-config-tick ordpipe-guardrail-reconcile; do
            aws events disable-rule --region "$region" --name "$rule" 2>/dev/null || true
        done

        # Drop provisioned concurrency on the consumer alias so the version/alias
        # delete is not blocked by an in-progress allocation.
        aws lambda delete-provisioned-concurrency-config --region "$region" \
            --function-name ordpipe-order-processor --qualifier live 2>/dev/null || true

        # Disable every event source mapping on the pipeline queues so nothing is
        # polling while the queues go away.
        for fn in ordpipe-order-processor ordpipe-order-processor-express \
                  ordpipe-notification-fanout ordpipe-payment-settler \
                  ordpipe-analytics-tap; do
            aws lambda list-event-source-mappings --region "$region" --function-name "$fn" \
                --query 'EventSourceMappings[].UUID' --output text 2>/dev/null | \
                tr '\t' '\n' | while read -r uuid; do
                    [ -n "$uuid" ] && aws lambda update-event-source-mapping --region "$region" \
                        --uuid "$uuid" --no-enabled 2>/dev/null || true
                done
        done
    done

    echo "pre-destroy sweep complete."
    exit 0
fi

echo "=== post: sweep pipeline resources CloudFormation may have left behind ==="
for region in $REGIONS; do
    # Log groups (Lambda recreates these outside CFN if a function ran after the
    # stack delete started).
    aws logs describe-log-groups --region "$region" \
        --log-group-name-prefix "/aws/lambda/ordpipe-" \
        --query 'logGroups[].logGroupName' --output text 2>/dev/null | \
        tr '\t' '\n' | while read -r lg; do
            [ -n "$lg" ] && aws logs delete-log-group --region "$region" --log-group-name "$lg" 2>/dev/null || true
        done

    aws logs describe-log-groups --region "$region" \
        --log-group-name-prefix "/aws/lambda/CDK" \
        --query 'logGroups[].logGroupName' --output text 2>/dev/null | \
        tr '\t' '\n' | while read -r lg; do
            [ -n "$lg" ] && aws logs delete-log-group --region "$region" --log-group-name "$lg" 2>/dev/null || true
        done

    # Alarms, SSM parameters and tables carrying the pipeline prefix.
    aws cloudwatch describe-alarms --region "$region" --alarm-name-prefix "ordpipe-" \
        --query 'MetricAlarms[].AlarmName' --output text 2>/dev/null | \
        tr '\t' '\n' | while read -r alarm; do
            [ -n "$alarm" ] && aws cloudwatch delete-alarms --region "$region" --alarm-names "$alarm" 2>/dev/null || true
        done

    aws ssm describe-parameters --region "$region" \
        --parameter-filters "Key=Name,Option=BeginsWith,Values=/ordpipe/" \
        --query 'Parameters[].Name' --output text 2>/dev/null | \
        tr '\t' '\n' | while read -r param; do
            [ -n "$param" ] && aws ssm delete-parameter --region "$region" --name "$param" 2>/dev/null || true
        done

    aws cloudwatch delete-dashboards --region "$region" \
        --dashboard-names ordpipe-order-pipeline 2>/dev/null || true

    for table in ordpipe-orders-processed ordpipe-inventory-catalog \
                 ordpipe-notifications-audit ordpipe-platform-config-audit \
                 ordpipe-platform-guardrail-audit; do
        aws dynamodb delete-table --region "$region" --table-name "$table" 2>/dev/null || true
    done

    for queue in ordpipe-orders-ingest ordpipe-orders-ingest-dlq ordpipe-orders-replay \
                 ordpipe-notifications ordpipe-notifications-dlq \
                 ordpipe-payments-settlement ordpipe-payments-settlement-dlq; do
        url=$(aws sqs get-queue-url --region "$region" --queue-name "$queue" \
            --query QueueUrl --output text 2>/dev/null)
        [ -n "${url:-}" ] && [ "$url" != "None" ] && \
            aws sqs delete-queue --region "$region" --queue-url "$url" 2>/dev/null || true
    done
done

echo "Cleanup complete."
exit 0
