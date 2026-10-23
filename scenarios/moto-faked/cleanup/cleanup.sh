#!/bin/bash
# Cleanup hook for moto-faked scenario.
# Destroys every stack in the scenario; `cdk destroy --force` on an already
# deleted stack is a no-op, so reruns after partial cleanup are safe.
set -euo pipefail

cd /app/cdk_app

export CDK_DEFAULT_ACCOUNT="${PRIMARY:-${CDK_DEFAULT_ACCOUNT:-}}"
if [ -z "$CDK_DEFAULT_ACCOUNT" ]; then
    echo "[cleanup.sh] CDK_DEFAULT_ACCOUNT/PRIMARY not set; nothing to destroy." >&2
    exit 0
fi

npm run build >/dev/null 2>&1 || true
npx cdk destroy --profile PRIMARY --all --force || {
    echo "[cleanup.sh] destroy reported an error; rerun is safe." >&2
    exit 0
}
echo "[cleanup.sh] moto-faked stacks destroyed."
