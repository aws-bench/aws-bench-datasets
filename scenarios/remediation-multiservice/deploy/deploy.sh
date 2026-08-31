#!/bin/bash
set -euo pipefail

cd /app/cdk_app

export CDK_DEFAULT_ACCOUNT="${PRIMARY}"

npm run build

for region in "us-east-1"; do
    npx cdk bootstrap --profile PRIMARY "aws://${PRIMARY}/${region}"
done

cdk_deploy() {
    if ! npx cdk deploy "$@"; then
        echo "cdk deploy failed; retrying once for transient CFN/IAM races..." >&2
        npx cdk deploy "$@"
    fi
}

cdk_deploy --profile PRIMARY --all --require-approval never --concurrency 10

# Run post-deploy setup scripts
echo "Running setup scripts..."
export AWS_PROFILE=PRIMARY
SETUP_DIR="/app/setup"
MAX_PARALLEL=10

scripts=()
for script in "$SETUP_DIR"/setup_*.py; do
    [ -f "$script" ] || continue
    scripts+=("$script")
done

if [ ${#scripts[@]} -eq 0 ]; then
    echo "No setup scripts found."
    exit 0
fi

echo "Running ${#scripts[@]} setup script(s) with parallelism=$MAX_PARALLEL"

failed=()
pids=()
names=()

for script in "${scripts[@]}"; do
    name=$(basename "$script")

    while [ ${#pids[@]} -ge $MAX_PARALLEL ]; do
        REAPED_PID=0
        wait -n -p REAPED_PID "${pids[@]}" 2>/dev/null && status=0 || status=$?
        for i in "${!pids[@]}"; do
            if [ "${pids[$i]}" -eq "$REAPED_PID" ]; then
                if [ $status -ne 0 ]; then
                    echo "  FAILED: ${names[$i]}" >&2
                    failed+=("${names[$i]}")
                else
                    echo "  OK: ${names[$i]}"
                fi
                unset 'pids[$i]' 'names[$i]'
                pids=("${pids[@]}")
                names=("${names[@]}")
                break
            fi
        done
    done

    echo "  START: $name"
    python3 "$script" &
    pids+=($!)
    names+=("$name")
done

for i in "${!pids[@]}"; do
    wait "${pids[$i]}" && status=0 || status=$?
    if [ $status -ne 0 ]; then
        echo "  FAILED: ${names[$i]}" >&2
        failed+=("${names[$i]}")
    else
        echo "  OK: ${names[$i]}"
    fi
done

if [ ${#failed[@]} -gt 0 ]; then
    echo "ERROR: ${#failed[@]} setup script(s) failed: ${failed[*]}" >&2
    exit 1
fi

echo "All setup scripts completed successfully."
