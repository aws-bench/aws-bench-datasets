#!/bin/bash
# EventBridge fulfillment cleanup. `pre` runs before the shared `cdk destroy --all`, `post` after.
set -uo pipefail

PHASE="${1:?usage: $0 pre|post}"

export AWS_PROFILE=PRIMARY
REGIONS="us-east-1"

if [ "$PHASE" = "pre" ]; then
    echo "=== pre: clear resources that block stack deletion ==="
    # Draining the target DLQ makes the queue delete immediate. Disabling the rules
    # stops in-flight events re-creating table items mid-destroy.
    for region in $REGIONS; do
        for bus in fulfillment-events-prod fulfillment-events-staging; do
            aws events list-rules --region "$region" --event-bus-name "$bus" \
                --query 'Rules[].Name' --output text 2>/dev/null | tr '\t' '\n' | \
                while read -r rule; do
                    [ -n "$rule" ] || continue
                    aws events disable-rule --region "$region" --event-bus-name "$bus" --name "$rule" 2>/dev/null || true
                done
        done

        dlq_url=$(aws sqs get-queue-url --region "$region" \
            --queue-name fulfillment-eventbridge-target-dlq --query QueueUrl --output text 2>/dev/null)
        if [ -n "${dlq_url:-}" ] && [ "$dlq_url" != "None" ]; then
            aws sqs purge-queue --region "$region" --queue-url "$dlq_url" 2>/dev/null || true
        fi
    done

    echo "pre-destroy sweep complete."
    exit 0
fi

echo "=== post: delete CDK custom-resource log groups ==="
for region in $REGIONS; do
    for prefix in "/aws/lambda/CDK" "/aws/lambda/AWS" "/aws/lambda/fulfillment" "/aws/events/fulfillment"; do
        aws logs describe-log-groups --region "$region" \
            --log-group-name-prefix "$prefix" \
            --query 'logGroups[].logGroupName' --output text 2>/dev/null | \
            tr '\t' '\n' | while read -r lg; do
                [ -n "$lg" ] && aws logs delete-log-group --region "$region" --log-group-name "$lg" 2>/dev/null || true
            done
    done
done

echo "=== post: sweep any resources CFN left behind ==="
for region in $REGIONS; do
    for table in fulfillment-event-records fulfillment-event-records-staging \
                 fulfillment-tier-summary fulfillment-tier-policy; do
        aws dynamodb delete-table --region "$region" --table-name "$table" 2>/dev/null || true
    done
    for bus in fulfillment-events-prod fulfillment-events-staging; do
        aws events list-rules --region "$region" --event-bus-name "$bus" \
            --query 'Rules[].Name' --output text 2>/dev/null | tr '\t' '\n' | \
            while read -r rule; do
                [ -n "$rule" ] || continue
                ids=$(aws events list-targets-by-rule --region "$region" --event-bus-name "$bus" \
                        --rule "$rule" --query 'Targets[].Id' --output text 2>/dev/null | tr '\t' ' ')
                [ -n "$ids" ] && aws events remove-targets --region "$region" --event-bus-name "$bus" \
                    --rule "$rule" --ids $ids 2>/dev/null || true
                aws events delete-rule --region "$region" --event-bus-name "$bus" --name "$rule" 2>/dev/null || true
            done
        aws events delete-event-bus --region "$region" --name "$bus" 2>/dev/null || true
    done
    aws cloudwatch delete-alarms --region "$region" --alarm-names \
        fulfillment-shipped-field-defaults-alarm \
        fulfillment-processor-errors-alarm \
        fulfillment-target-dlq-depth-alarm 2>/dev/null || true
    aws cloudwatch delete-dashboards --region "$region" \
        --dashboard-names fulfillment-event-pipeline 2>/dev/null || true
done

echo "Cleanup complete."
exit 0
