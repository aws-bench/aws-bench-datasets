#!/bin/bash
# Scenario reset hook for remediation-multiservice.
#
# Re-runs every task's post_invoke as a backstop. A cancelled or timed-out
# trial can leave one half-applied, and nothing else restores what it would
# have restored. Each post_invoke is idempotent, so re-running a completed
# one is a no-op.
#
# Best-effort: a failure is reported and never fatal.
set -uo pipefail

POST_INVOKES_DIR="/reset/post_invokes"

echo "[reset.sh] remediation-multiservice reset"

if [ ! -d "${POST_INVOKES_DIR}" ]; then
    echo "[reset.sh] No ${POST_INVOKES_DIR} directory found, skipping."
    echo "[reset.sh] Done. Framework reset will handle the rest."
    exit 0
fi

export AWS_PROFILE="PRIMARY"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"

failed=()

for task_dir in "${POST_INVOKES_DIR}"/*; do
    [ -d "${task_dir}" ] || continue
    task_name="$(basename "${task_dir}")"
    post_invoke_sh="${task_dir}/post_invoke.sh"

    if [ ! -f "${post_invoke_sh}" ]; then
        echo "[reset.sh]   SKIP: ${task_name} (no post_invoke.sh)"
        continue
    fi

    echo "[reset.sh]   running post_invoke for ${task_name}"
    if ! (cd "${task_dir}" && bash post_invoke.sh); then
        echo "[reset.sh]   ERROR: post_invoke failed for ${task_name}" >&2
        failed+=("${task_name}")
    fi
done

if [ "${#failed[@]}" -gt 0 ]; then
    echo "[reset.sh] ${#failed[@]} post_invoke(s) did not complete: ${failed[*]}" >&2
fi

echo "[reset.sh] Done. Framework reset will handle the rest."
exit 0
