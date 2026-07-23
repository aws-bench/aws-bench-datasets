#!/usr/bin/env bash
#
# check-toolchain-pinning.sh: report the version-pin status of the verifier
# toolchain in each task's environment/Dockerfile and tests/test.sh.
#
# ADVISORY ONLY. This script never exits non-zero on an unpinned package; it
# prints an inventory so the team can decide whether to pin. Floating versions
# are a runner-stability risk (a breaking upstream release can fail runs
# spuriously), not a verdict-correctness risk.
#
# Scope: the verifier toolchain only (uv, harbor-rewardkit, pyyaml, AWS CLI).
# boto3 is intentionally EXEMPT: the team does not want to pin it (tasks should
# run against current AWS SDK behavior).
#
# Usage:
#   check-toolchain-pinning.sh [task_dir ...]   # default: all tasks/<env>/<task>
#
# Output: one line per (file, dependency) as
#   PINNED   <path>: <dep> == <version>
#   UNPINNED <path>: <dep> (floating)
#   EXEMPT   <path>: <dep> (pinning not required)
# plus a trailing summary. Always exits 0.

set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Packages we report a pin status for. boto3 is included so it is visibly
# reported as EXEMPT (the team does not want it pinned), rather than silently
# dropped. `uv` is NOT in this list: it is the install tool, not an installed
# package (the literal "uv" in `uv pip install` is not a dependency), so its pin
# status is detected separately via the astral-sh release URL.
EXEMPT_DEPS="boto3"
TRACKED_DEPS="harbor-rewardkit pyyaml awscli boto3"

pinned=0
unpinned=0
exempt=0

is_exempt() {
    local dep="$1"
    for e in $EXEMPT_DEPS; do
        [ "$dep" = "$e" ] && return 0
    done
    return 1
}

# Given a file, scan pip/uv/uvx install lines and report each tracked dep.
scan_file() {
    local file="$1"
    [ -f "$file" ] || return 0
    local rel="${file#"$ROOT_DIR"/}"
    local uver ver

    # Scan each line. Two independent signals, both via bash string matching
    # (no per-line subshells, so this stays fast across the whole dataset):
    #  (a) `uv` is pinned via a versioned astral-sh release URL.
    #  (b) tracked packages on an install line (`uv pip install`, `pip install`,
    #      `uvx --from/--with`) carry a pin iff followed by ==version.
    while IFS= read -r line; do
        # (a) uv release-URL pin signal.
        if [[ "$line" == *astral-sh/uv/releases/download/[0-9]* ]]; then
            uver="${line#*astral-sh/uv/releases/download/}"
            uver="${uver%%/*}"
            echo "PINNED   $rel: uv == $uver (release URL)"
            pinned=$((pinned + 1))
        fi

        # (b) only inspect package tokens on actual install lines.
        case "$line" in
            *uvx*|*"pip install"*) : ;;
            *) continue ;;
        esac

        for dep in $TRACKED_DEPS; do
            # Present as a bare/`--with`/`--from` arg? Require a boundary before
            # the dep so e.g. "boto3" does not match inside another token.
            case "$line" in
                *[[:space:]=]"$dep"==[0-9]*)
                    ver="${line#*"$dep"==}"
                    ver="${ver%%[[:space:]\"\']*}"
                    echo "PINNED   $rel: $dep == $ver"
                    pinned=$((pinned + 1))
                    ;;
                *[[:space:]=]"$dep"[[:space:]]*|*[[:space:]=]"$dep")
                    if is_exempt "$dep"; then
                        echo "EXEMPT   $rel: $dep (pinning not required)"
                        exempt=$((exempt + 1))
                    else
                        echo "UNPINNED $rel: $dep (floating)"
                        unpinned=$((unpinned + 1))
                    fi
                    ;;
            esac
        done
    done < "$file"
}

# Build the task list: args, or all tasks.
task_dirs=()
if [ "$#" -gt 0 ]; then
    task_dirs=("$@")
else
    while IFS= read -r toml; do
        task_dirs+=("$(dirname "$toml")")
    done < <(find "$ROOT_DIR/tasks" -mindepth 3 -maxdepth 3 -name task.toml 2>/dev/null | sort)
fi

if [ "${#task_dirs[@]}" -eq 0 ]; then
    echo "No tasks to check."
    exit 0
fi

for d in "${task_dirs[@]}"; do
    scan_file "$d/environment/Dockerfile"
    scan_file "$d/tests/test.sh"
done

echo ""
echo "Toolchain pinning summary (advisory): pinned=$pinned unpinned=$unpinned exempt=$exempt"
echo "boto3 is exempt by policy. Unpinned packages are a runner-stability signal, not a verdict gate."
exit 0
