#!/bin/bash
set -euo pipefail

cd /app/cdk_app

export CDK_DEFAULT_ACCOUNT="$PRIMARY"

npm run build

npx cdk bootstrap --profile PRIMARY "aws://${PRIMARY}/us-east-1"

# One retry for transient create races: IAM propagation can lag role creation
# enough that Lambda CreateFunction fails ("The role defined for the function
# cannot be assumed by Lambda"), rolling the stack back to ROLLBACK_COMPLETE.
# On the retry, cdk deletes the creation-failed stack and recreates it;
# already-completed stacks are no-op'd.
cdk_deploy() {
    if ! npx cdk deploy "$@"; then
        echo "cdk deploy failed; retrying once for transient CFN/IAM races..." >&2
        npx cdk deploy "$@"
    fi
}

cdk_deploy --profile PRIMARY \
    --all \
    --require-approval never \
    --concurrency 10
