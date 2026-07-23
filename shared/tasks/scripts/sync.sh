#!/usr/bin/env bash
# Copy canonical per-task helper files into each task's hook dirs.
#
# Canonical source lives at:
#   shared/tasks/<scenario>/<task>/<helper>
#
# Each such file is copied verbatim into every hook dir of the matching task
# (by default pre_invoke/ and post_invoke/), e.g.:
#   tasks/<scenario>/<task>/pre_invoke/reset.py
#   tasks/<scenario>/<task>/post_invoke/reset.py
#
# harbor uploads each hook dir to the container as its own root, so a single
# shared file cannot span both phases; each hook dir needs its own copy. This
# script keeps those copies in lockstep with the canonical source.
#
# Any file placed under shared/tasks/<scenario>/<task>/ is synced (not just
# reset.py). Set HOOKS to change which hook dirs receive the copies.
#
# Modes:
#   sync.sh            Copy canonical files into every task's hook dirs (default).
#   sync.sh --check    Verify the copies match the canonical source. Exits
#                      non-zero on the first drift. Use this in CI.

set -euo pipefail

MODE="sync"
case "${1:-}" in
    --check) MODE="check" ;;
    "") MODE="sync" ;;
    *)
        echo "Usage: $0 [--check]" >&2
        exit 2
        ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SHARED_TASKS_DIR="$REPO_ROOT/shared/tasks"
TASK_BUCKETS=("$REPO_ROOT/tasks")

# Hook dirs each canonical file is copied into. Override via env if needed.
read -r -a HOOKS <<< "${HOOKS:-pre_invoke post_invoke}"

# This script itself lives under shared/tasks/scripts/; never treat scripts/
# contents as canonical task helpers.
SCRIPTS_DIR="$SHARED_TASKS_DIR/scripts"

count=0
diff_count=0
missing_count=0

# Iterate every canonical helper file under shared/tasks/<scenario>/<task>/.
while IFS= read -r -d '' src; do
    # Skip anything under shared/tasks/scripts/.
    case "$src" in "$SCRIPTS_DIR"/*) continue ;; esac

    # Derive <scenario>/<task>/<helper...> from the path under shared/tasks/.
    rel="${src#"$SHARED_TASKS_DIR"/}"        # <scenario>/<task>/<helper>
    fname="$(basename "$src")"               # e.g. reset.py
    # <scenario>/<task> is the first two path components.
    scenario="$(echo "$rel" | cut -d/ -f1)"
    task="$(echo "$rel" | cut -d/ -f2)"

    # Locate the task in whichever launch-phase bucket currently holds it.
    task_dir=""
    for bucket in "${TASK_BUCKETS[@]}"; do
        if [[ -d "$bucket/$scenario/$task" ]]; then
            task_dir="$bucket/$scenario/$task"
            break
        fi
    done

    if [[ -z "$task_dir" ]]; then
        echo "MISSING: no task dir for $scenario/$task (canonical $src) in any bucket: ${TASK_BUCKETS[*]}" >&2
        missing_count=$((missing_count + 1))
        continue
    fi

    for hook in "${HOOKS[@]}"; do
        hook_dir="$task_dir/$hook"
        if [[ ! -d "$hook_dir" ]]; then
            echo "MISSING: $hook_dir (task has canonical $fname but no $hook/ dir)" >&2
            missing_count=$((missing_count + 1))
            continue
        fi
        dest="$hook_dir/$fname"
        if [[ "$MODE" == "check" ]]; then
            if ! cmp -s "$src" "$dest"; then
                echo "DRIFT: $dest differs from canonical $src" >&2
                diff_count=$((diff_count + 1))
            fi
        else
            cp "$src" "$dest"
        fi
    done
    count=$((count + 1))
done < <(find "$SHARED_TASKS_DIR" -type f -not -path "$SCRIPTS_DIR/*" -print0 2>/dev/null)

if [[ "$MODE" == "check" ]]; then
    if [[ $diff_count -gt 0 || $missing_count -gt 0 ]]; then
        echo "Found $diff_count drifted and $missing_count missing target(s) across $count file(s). Run sync.sh to fix." >&2
        exit 1
    fi
    echo "Checked $count canonical helper file(s); all in sync."
else
    if [[ $missing_count -gt 0 ]]; then
        echo "Synced $count file(s) with $missing_count missing target(s) skipped." >&2
        exit 1
    fi
    echo "Synced $count canonical helper file(s) into their hook dirs."
fi

# ── Copy post_invoke folders into scenario reset/ directories ─────────────────
# For each scenario that has a reset/ directory, copy the post_invoke/ folder of
# every task that has one into reset/post_invokes/<task_name>/.
SCENARIOS_DIR="$REPO_ROOT/scenarios"
pi_count=0

while IFS= read -r -d '' reset_dir; do
    scenario_name="$(basename "$(dirname "$reset_dir")")"
    dest_base="$reset_dir/post_invokes"

    # A scenario's reset/ dir lives once under scenarios/, but its tasks may be
    # spread across every launch-phase bucket. Gather all of them so the reset
    # post_invokes stay complete regardless of how tasks are bucketed.
    scenario_task_dirs=()
    for bucket in "${TASK_BUCKETS[@]}"; do
        [[ -d "$bucket/$scenario_name" ]] || continue
        for task_dir in "$bucket/$scenario_name"/*/; do
            [ -d "$task_dir" ] || continue
            scenario_task_dirs+=("$task_dir")
        done
    done

    if [[ ${#scenario_task_dirs[@]} -eq 0 ]]; then
        continue
    fi

    if [[ "$MODE" == "sync" ]]; then
        rm -rf "$dest_base"
        mkdir -p "$dest_base"
    fi

    for task_dir in "${scenario_task_dirs[@]}"; do
        src_post_invoke="${task_dir}post_invoke"
        if [[ ! -d "$src_post_invoke" ]]; then
            continue
        fi
        task_name="$(basename "$task_dir")"
        dest_task="$dest_base/$task_name"
        if [[ "$MODE" == "check" ]]; then
            if ! diff -rq "$src_post_invoke" "$dest_task" >/dev/null 2>&1; then
                echo "DRIFT: $dest_task differs from $src_post_invoke" >&2
                diff_count=$((diff_count + 1))
            fi
        else
            cp -r "$src_post_invoke" "$dest_task"
        fi
        pi_count=$((pi_count + 1))
    done
done < <(find "$SCENARIOS_DIR" -maxdepth 2 -type d -name "reset" -print0 2>/dev/null)

if [[ "$MODE" == "check" ]]; then
    if [[ $diff_count -gt 0 ]]; then
        echo "Found $diff_count drifted post_invoke folder(s). Run sync.sh to fix." >&2
        exit 1
    fi
    echo "Checked $pi_count post_invoke folder(s) in reset dirs; all in sync."
else
    echo "Copied $pi_count post_invoke folder(s) into scenario reset dirs."
fi
