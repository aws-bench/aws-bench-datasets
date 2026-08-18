#!/usr/bin/env bash
#
# check-task-toml-parses.sh: parse every task.toml with a real TOML parser and
# fail on any file the parser rejects.
#
# BLOCKING. A task.toml that does not parse cannot be loaded by the framework at
# run time, so this runs ahead of the field/content checks, which match on text
# and accept files no parser would.
#
# Catches what a text scan cannot: duplicate keys within a table, bad escapes,
# malformed inline tables/arrays, and any other syntax the spec rejects.
#
# Usage:
#   check-task-toml-parses.sh [task_dir ...]   # default: all tasks/<env>/<task>
#
# Output: one "FAIL <path>: <parser message>" line per rejected file plus a
# trailing count. Exits 1 if any file was rejected, 0 otherwise.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# tomllib is in the standard library from 3.11. python3 is not a declared
# prerequisite of this repo but uv is, and uv supplies an interpreter.
if command -v python3 >/dev/null 2>&1; then
    PY=(python3)
else
    PY=(uv run --no-project --quiet python)
fi

# Build the file list: a task.toml per argument, or every task's task.toml.
files=()
if [ "$#" -gt 0 ]; then
    for task_dir in "$@"; do
        [ -f "$task_dir/task.toml" ] && files+=("$task_dir/task.toml")
    done
else
    while IFS= read -r toml; do
        files+=("$toml")
    done < <(find "$ROOT_DIR/tasks" -mindepth 3 -maxdepth 3 -name task.toml 2>/dev/null | sort)
fi

if [ "${#files[@]}" -eq 0 ]; then
    echo "No task.toml files to check"
    exit 0
fi

"${PY[@]}" -c '
import sys, tomllib

failed = 0
for path in sys.argv[1:]:
    try:
        with open(path, "rb") as fh:
            tomllib.load(fh)
    except tomllib.TOMLDecodeError as exc:
        print(f"FAIL {path}: {exc}")
        failed += 1
    except OSError as exc:
        print(f"FAIL {path}: {exc}")
        failed += 1

total = len(sys.argv) - 1
if failed:
    print(f"\n{failed} of {total} task.toml file(s) are not valid TOML.")
    sys.exit(1)
print(f"All {total} task.toml file(s) parse as valid TOML.")
' "${files[@]}"
