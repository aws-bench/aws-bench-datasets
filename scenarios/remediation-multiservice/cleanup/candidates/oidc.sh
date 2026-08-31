#!/bin/bash
# GitHub-OIDC CodeBuild federation cleanup. `pre` runs before the shared `cdk destroy --all`, `post` after.
set -uo pipefail

PHASE="${1:?usage: $0 pre|post}"

export AWS_PROFILE=PRIMARY
REGION="us-east-1"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")"

BASELINE_ROLES=(
    "acme-ci-github-deploy-role"
    "acme-ci-github-deploy-role-staging"
    "acme-ci-github-deploy-role-notifications"
    "acme-ci-github-audit-readonly-role"
    "acme-deploy-orchestrator-role"
    "acme-ci-codebuild-runner-role"
)
BASELINE_INLINE_POLICIES=(
    "acme-ci-deploy-permissions"
    "acme-ci-staging-deploy-permissions"
    "acme-ci-notifications-deploy-permissions"
    "acme-ci-audit-readonly-permissions"
)

if [ "$PHASE" = "pre" ]; then
    echo "=== pre: clear resources that block stack deletion ==="

    # IAM DeleteRole fails while a role still carries policies CloudFormation does not own
    # (e.g. anything an agent attached during a trial).
    for role in "${BASELINE_ROLES[@]}"; do
        aws iam list-attached-role-policies --role-name "$role" \
            --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null | \
            tr '\t' '\n' | while read -r arn; do
                [ -n "$arn" ] && aws iam detach-role-policy --role-name "$role" --policy-arn "$arn" 2>/dev/null || true
            done
        aws iam list-role-policies --role-name "$role" \
            --query 'PolicyNames[]' --output text 2>/dev/null | \
            tr '\t' '\n' | while read -r pol; do
                [ -z "$pol" ] && continue
                keep="no"
                for known in "${BASELINE_INLINE_POLICIES[@]}"; do
                    [ "$pol" = "$known" ] && keep="yes"
                done
                if [ "$keep" = "no" ]; then
                    aws iam delete-role-policy --role-name "$role" --policy-name "$pol" 2>/dev/null || true
                fi
            done
    done

    # Empty the CI artifact bucket (belt and braces alongside autoDeleteObjects).
    if [ -n "${ACCOUNT_ID:-}" ]; then
        aws s3 rm "s3://acme-ci-artifacts-${ACCOUNT_ID}" --recursive 2>/dev/null || true
    fi

    # Stop any CodeBuild build still running (a running build blocks project deletion).
    for project in payments-api-gha-runner legacy-service-gha-runner payments-api-staging-gha-runner acme-notifications-svc-gha-runner; do
        aws codebuild list-builds-for-project --project-name "$project" --region "$REGION" \
            --query 'ids[0:5]' --output text 2>/dev/null | tr '\t' '\n' | while read -r bid; do
                [ -n "$bid" ] && aws codebuild stop-build --id "$bid" --region "$REGION" >/dev/null 2>&1 || true
            done
    done

    echo "pre-destroy sweep complete."
    exit 0
fi

echo "=== post: sweep anything CloudFormation left behind ==="

# OIDC identity provider
if [ -n "${ACCOUNT_ID:-}" ]; then
    aws iam delete-open-id-connect-provider \
        --open-id-connect-provider-arn "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com" \
        2>/dev/null || true
fi

# leftover roles
for role in "${BASELINE_ROLES[@]}"; do
    aws iam list-role-policies --role-name "$role" --query 'PolicyNames[]' --output text 2>/dev/null | \
        tr '\t' '\n' | while read -r pol; do
            [ -n "$pol" ] && aws iam delete-role-policy --role-name "$role" --policy-name "$pol" 2>/dev/null || true
        done
    aws iam list-attached-role-policies --role-name "$role" --query 'AttachedPolicies[].PolicyArn' \
        --output text 2>/dev/null | tr '\t' '\n' | while read -r arn; do
            [ -n "$arn" ] && aws iam detach-role-policy --role-name "$role" --policy-arn "$arn" 2>/dev/null || true
        done
    aws iam delete-role --role-name "$role" 2>/dev/null || true
done

# leftover SSM parameters
aws ssm get-parameters-by-path --path /acme --recursive --region "$REGION" \
    --query 'Parameters[].Name' --output text 2>/dev/null | tr '\t' '\n' | while read -r name; do
        [ -n "$name" ] && aws ssm delete-parameter --name "$name" --region "$REGION" 2>/dev/null || true
    done

# leftover log groups
for lg in /aws/codebuild/payments-api-gha-runner /aws/codebuild/legacy-service-gha-runner \
          /aws/codebuild/payments-api-staging-gha-runner /aws/lambda/acme-deploy-orchestrator; do
    aws logs delete-log-group --region "$REGION" --log-group-name "$lg" 2>/dev/null || true
done

# log groups auto-created by CDK custom-resource lambdas (outside the stack)
for prefix in "/aws/lambda/remediation-multiservice" "/aws/lambda/CDK"; do
    aws logs describe-log-groups --region "$REGION" \
        --log-group-name-prefix "$prefix" \
        --query 'logGroups[].logGroupName' --output text 2>/dev/null | \
        tr '\t' '\n' | while read -r lg; do
            [ -n "$lg" ] && aws logs delete-log-group --region "$REGION" --log-group-name "$lg" 2>/dev/null || true
        done
done

echo "Cleanup complete."
exit 0
