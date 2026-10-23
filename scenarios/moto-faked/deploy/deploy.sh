#!/bin/bash
# Deploy hook for the moto-faked scenario.
# Idempotent: `cdk deploy` no-ops stacks whose templates are unchanged, so a
# rerun after a partial failure resumes instead of duplicating resources.
# One retry covers transient CFN/IAM races (role propagation lag).
set -euo pipefail

cd /app/cdk_app

# aws-bench has written ~/.aws/config with one profile per account tag.
# CDK assumes the role declared in the profile (auto-refreshing on expiry)
# when invoked with --profile.
export CDK_DEFAULT_ACCOUNT="$PRIMARY"

npm run build

# Bootstrapping is idempotent.
for region in us-east-1; do
    npx cdk bootstrap --profile PRIMARY "aws://${PRIMARY}/${region}"
done

cdk_deploy() {
    if ! npx cdk deploy "$@"; then
        echo "cdk deploy failed; retrying once for transient CFN/IAM races..." >&2
        npx cdk deploy "$@"
    fi
}

cdk_deploy --profile PRIMARY --all --require-approval never --concurrency 10
