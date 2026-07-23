#!/bin/bash
# Scenario reset hook for compute-and-data.
#
# Runs BEFORE the framework's reset (new-resource scan + stack teardown). Its job
# is to execute per-task post_invoke scripts to roll back agent-created mutations
# that may block stack deletion or pollute subsequent trials.
#
# Best-effort and idempotent: each post_invoke tolerates "already gone" state.
# Never fail the phase — the framework reset runs afterwards regardless.
set -uo pipefail

POST_INVOKES_DIR="/reset/post_invokes"

echo "[reset.sh] compute-and-data reset"

# ── Run per-task post_invoke scripts ──────────────────────────────────────────
if [ ! -d "${POST_INVOKES_DIR}" ]; then
    echo "[reset.sh] No post_invokes/ directory found, skipping."
else
    echo "[reset.sh] Running per-task post_invoke scripts..."
    export AWS_PROFILE="PRIMARY"
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
            echo "[reset.sh]   ERROR: post_invoke failed for ${task_name}"
        fi
    done
fi

echo "[reset.sh] Done. Framework reset will handle the rest."
exit 0
