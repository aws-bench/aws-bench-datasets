#!/bin/bash
# Bedrock document-extraction cleanup. `pre` runs before the shared `cdk destroy --all`, `post` after.
set -uo pipefail

PHASE="${1:?usage: $0 pre|post}"

export AWS_PROFILE=PRIMARY

REGION="us-east-1"
DEP="uyvjsf7fj"
DOC_BUCKET_PREFIX="docintel-documents-${DEP}"
STACK_PREFIX="remediation-multiservice"

if [ "$PHASE" = "pre" ]; then
    echo "=== pre: clear resources that block stack deletion ==="

    # Empty the bucket before destroy so the autoDeleteObjects custom resource
    # cannot time out on a large keyspace.
    for bucket in $(aws s3api list-buckets --query "Buckets[?starts_with(Name, '${DOC_BUCKET_PREFIX}')].Name" --output text 2>/dev/null | tr '\t' '\n'); do
        [ -n "$bucket" ] || continue
        echo "emptying s3://${bucket}"
        aws s3 rm "s3://${bucket}" --recursive 2>/dev/null || true
        aws s3api delete-objects --bucket "$bucket" \
            --delete "$(aws s3api list-object-versions --bucket "$bucket" \
                --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}' --output json 2>/dev/null)" 2>/dev/null || true
    done

    # Drain the alarm inbox / DLQ so queue deletion is not delayed by in-flight messages.
    for q in "docintel-extraction-alerts-inbox-${DEP}" "docintel-extraction-dlq-${DEP}"; do
        url=$(aws sqs get-queue-url --region "$REGION" --queue-name "$q" --query QueueUrl --output text 2>/dev/null)
        if [ -n "${url:-}" ] && [ "$url" != "None" ]; then
            aws sqs purge-queue --region "$REGION" --queue-url "$url" 2>/dev/null || true
        fi
    done

    echo "pre-destroy sweep complete."
    exit 0
fi

echo "=== post: delete CDK custom-resource log groups ==="
for prefix in "/aws/lambda/CDK" "/aws/lambda/${STACK_PREFIX}" "/aws/lambda/docintel-extraction-router-${DEP}"; do
    aws logs describe-log-groups --region "$REGION" \
        --log-group-name-prefix "$prefix" \
        --query 'logGroups[].logGroupName' --output text 2>/dev/null | \
        tr '\t' '\n' | while read -r lg; do
            [ -n "$lg" ] && aws logs delete-log-group --region "$REGION" --log-group-name "$lg" 2>/dev/null || true
        done
done

echo "=== post: sweep leftover service resources CFN may have skipped ==="
for table in "docintel-extraction-profiles-${DEP}" "docintel-extraction-runs-${DEP}"; do
    aws dynamodb delete-table --region "$REGION" --table-name "$table" 2>/dev/null || true
done
for alarm in "docintel-extraction-failures-${DEP}" "docintel-extraction-router-invoke-errors-${DEP}"; do
    aws cloudwatch delete-alarms --region "$REGION" --alarm-names "$alarm" 2>/dev/null || true
done
for bucket in $(aws s3api list-buckets --query "Buckets[?starts_with(Name, '${DOC_BUCKET_PREFIX}')].Name" --output text 2>/dev/null | tr '\t' '\n'); do
    [ -n "$bucket" ] || continue
    aws s3 rb "s3://${bucket}" --force 2>/dev/null || true
done

echo "Cleanup complete."
exit 0
