#!/bin/bash
# ECS/ECR container-delivery cleanup. `pre` runs before the shared `cdk destroy --all`, `post` after.
set -uo pipefail

PHASE="${1:?usage: $0 pre|post}"

export AWS_PROFILE=PRIMARY
REGION="us-east-1"
CLUSTER="checkout-platform"
API_REPO="platform/checkout-api"
WORKER_REPO="platform/checkout-worker"

if [ "$PHASE" = "pre" ]; then
    echo "=== pre: clear resources that block stack deletion ==="

    # Scale services to zero first so tasks and ENIs are released before
    # CloudFormation deletes the cluster and the ALB. A service whose image cannot
    # be pulled retries placement indefinitely, churning an ENI per attempt.
    for svc in checkout-api-svc checkout-worker-svc; do
        aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$svc" \
            --desired-count 0 2>/dev/null || true
    done
    for svc in checkout-api-svc checkout-worker-svc; do
        aws ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services "$svc" 2>/dev/null || true
    done

    # Drop every image so repository deletion cannot be blocked.
    for repo in "$API_REPO" "$WORKER_REPO"; do
        ids=$(aws ecr list-images --region "$REGION" --repository-name "$repo" \
            --query 'imageIds[*]' --output json 2>/dev/null || echo '[]')
        if [ "$ids" != "[]" ] && [ -n "$ids" ]; then
            aws ecr batch-delete-image --region "$REGION" --repository-name "$repo" \
                --image-ids "$ids" >/dev/null 2>&1 || true
        fi
    done

    echo "pre-destroy sweep complete."
    exit 0
fi

echo "=== post: delete CDK custom-resource log groups ==="
for region in "us-east-1"; do
    aws logs describe-log-groups --region "$region" \
        --log-group-name-prefix "/aws/lambda/CDK" \
        --query 'logGroups[].logGroupName' --output text 2>/dev/null | \
        tr '\t' '\n' | while read -r lg; do
            [ -n "$lg" ] && aws logs delete-log-group --region "$region" --log-group-name "$lg" 2>/dev/null || true
        done
done

echo "=== post: sweep non-CFN leftovers of the checkout platform ==="
# Task definition revisions registered outside CloudFormation.
for family in checkout-api checkout-worker; do
    for status in ACTIVE INACTIVE; do
        aws ecs list-task-definitions --region "$REGION" --family-prefix "$family" --status "$status" \
            --query 'taskDefinitionArns[]' --output text 2>/dev/null | tr '\t' '\n' | while read -r td; do
                [ -n "$td" ] || continue
                if [ "$status" = "ACTIVE" ]; then
                    aws ecs deregister-task-definition --region "$REGION" --task-definition "$td" >/dev/null 2>&1 || true
                fi
                aws ecs delete-task-definitions --region "$REGION" --task-definitions "$td" >/dev/null 2>&1 || true
            done
    done
done

# Repositories / cluster / parameter / alarms, in case a stack delete partially failed.
for repo in "$API_REPO" "$WORKER_REPO"; do
    aws ecr delete-repository --region "$REGION" --repository-name "$repo" --force 2>/dev/null || true
done
aws ecs delete-cluster --region "$REGION" --cluster "$CLUSTER" 2>/dev/null || true
aws ssm delete-parameter --region "$REGION" --name "/platform/checkout-api/canary/extra-tag" 2>/dev/null || true
aws cloudwatch delete-alarms --region "$REGION" \
    --alarm-names checkout-api-image-audit-errors checkout-api-alb-unhealthy-hosts 2>/dev/null || true

for prefix in "/ecs/checkout-" "/aws/codebuild/checkout-" "/aws/lambda/checkout-" "/vpc/checkout-platform"; do
    aws logs describe-log-groups --region "$REGION" --log-group-name-prefix "$prefix" \
        --query 'logGroups[].logGroupName' --output text 2>/dev/null | tr '\t' '\n' | while read -r lg; do
            [ -n "$lg" ] && aws logs delete-log-group --region "$REGION" --log-group-name "$lg" 2>/dev/null || true
        done
done

echo "=== post: delete setup-written SSM parameters ==="
# Written outside CDK, so it survives teardown and redeploy without this delete.
aws ssm delete-parameter --name "/platform/ecs/poisoned-revision-arns" --region "$REGION" 2>/dev/null || true

echo "Cleanup complete."
exit 0
