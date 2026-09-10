#!/usr/bin/env bash
# Copy shared rewardkit verifier files into every task that uses them.
#
# A task is considered "rewardkit-based" if it has a tests/judge.toml file.
# For each such task, the four canonical files (judge_prompt.md, judge.toml,
# test.sh, resolve_placeholders.py) are overwritten with the shared copy --
# EXCEPT for tasks whose judge.toml/judge_prompt.md have been intentionally
# customized into a per-claim rubric (no longer just the canonical single
# "answers_equivalent" criterion). For those tasks,
# only test.sh and resolve_placeholders.py are synced -- judge.toml and
# judge_prompt.md are deliberately per-task and must never be overwritten or
# flagged as drift. See is_customized() below for the detection rule.
#
# Modes:
#   sync.sh                          Copy shared files into every task (default).
#   sync.sh --check                  Verify shared files match across all tasks
#                                    (customized tasks are checked only on
#                                    test.sh/resolve_placeholders.py).
#                                    Exits non-zero on the first diff.
#   sync.sh --check-instructions     Verify each task's instruction.md matches
#                                    the 'instruction' field of its
#                                    tests/ground_truth.json. Exits non-zero on
#                                    the first drift.
#   sync.sh --check-placeholders     Verify every {{name}} token in each task's
#                                    ground_truth.json is declared in
#                                    [verifier.env] of task.toml. Exits non-zero
#                                    on the first undeclared token.
#   sync.sh --check-output-contract  For mutation tasks (tests/check.py present):
#                                    verify the JSON schema declared in
#                                    instruction.md matches the keys consumed
#                                    by check.py (AGENT_OUTPUT.get("KEY"),
#                                    AGENT_OUTPUT["KEY"], "KEY" in AGENT_OUTPUT,
#                                    and REQUIRED_OUTPUT_KEYS-style tuples).
#                                    Exits non-zero on declared/consumed drift.
#   sync.sh --check-trailers         Verify every instruction.md has the
#                                    canonical agent-contract trailer for its
#                                    [metadata].request_type, and that mutation
#                                    tasks with structured output use the
#                                    canonical "Additionally, write ..." form.
#                                    Exits non-zero on the first drift.
#
# Use --check / --check-instructions / --check-placeholders /
# --check-output-contract / --check-trailers in CI to detect drift.

set -euo pipefail

MODE="sync"
case "${1:-}" in
    --check) MODE="check" ;;
    --check-instructions) MODE="check_instructions" ;;
    --check-placeholders) MODE="check_placeholders" ;;
    --check-output-contract) MODE="check_output_contract" ;;
    --check-trailers) MODE="check_trailers" ;;
    "") MODE="sync" ;;
    *)
        echo "Usage: $0 [--check | --check-instructions | --check-placeholders | --check-output-contract | --check-trailers]" >&2
        exit 2
        ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SHARED_DIR="$REPO_ROOT/shared/judge"
TASKS_DIR="$REPO_ROOT/tasks"

FILES=(judge_prompt.md judge.toml test.sh resolve_placeholders.py)

# ── --check-instructions: instruction.md vs ground_truth.json[instruction] ──
if [[ "$MODE" == "check_instructions" ]]; then
    count=0
    drift_count=0
    while IFS= read -r -d '' gt_path; do
        task_dir="$(dirname "$(dirname "$gt_path")")"
        instruction_md="$task_dir/instruction.md"

        if [[ ! -f "$instruction_md" ]]; then
            echo "MISSING: $instruction_md (task has tests/ground_truth.json but no instruction.md)" >&2
            drift_count=$((drift_count + 1))
            count=$((count + 1))
            continue
        fi

        # Compare instruction.md vs ground_truth.json's "instruction" key.
        # instruction.md typically appends an agent contract line (e.g.
        # "IMPORTANT: Write your final answer to /logs/agent/agent-output.txt")
        # that the judge doesn't need; strip leading/trailing blank lines and
        # the "IMPORTANT: ..." trailer before comparing.
        diff_output=$(python3 - "$instruction_md" "$gt_path" <<'PYEOF'
import json
import re
import sys

md_path, gt_path = sys.argv[1], sys.argv[2]

def normalize(text: str) -> str:
    # Drop trailing IMPORTANT contract lines (they're agent-only).
    text = re.sub(r"\n+IMPORTANT:.*$", "", text, flags=re.DOTALL)
    return text.strip()

md = normalize(open(md_path).read())
with open(gt_path) as f:
    gt_instr = normalize(json.load(f).get("instruction", ""))

if md != gt_instr:
    sys.stdout.write("DIFF\n")
    sys.stdout.write(f"  instruction.md (normalized): {md[:160]!r}\n")
    sys.stdout.write(f"  ground_truth.json[instruction] (normalized): {gt_instr[:160]!r}\n")
PYEOF
)
        if [[ -n "$diff_output" ]]; then
            echo "DRIFT: $task_dir" >&2
            echo "$diff_output" >&2
            drift_count=$((drift_count + 1))
        fi
        count=$((count + 1))
    done < <(find "$TASKS_DIR" -name 'ground_truth.json' -path '*/tests/ground_truth.json' -print0)

    if [[ $drift_count -gt 0 ]]; then
        echo "Found $drift_count instruction drift(s) across $count task(s)." >&2
        exit 1
    fi
    echo "Checked instruction parity in $count task(s); all in sync."
    exit 0
fi

# ── --check-placeholders: every {{name}} in ground_truth.json must be in [verifier.env] ──
# Scoped to rewardkit-converted tasks (presence of tests/judge.toml). Tasks
# still on the legacy hand-rolled test.py have lenient substitution and a
# different invariant; this check doesn't apply to them.
if [[ "$MODE" == "check_placeholders" ]]; then
    python3 - "$TASKS_DIR" <<'PYEOF'
import re
import sys
from pathlib import Path

def verifier_env_keys(task_toml_text: str) -> set[str]:
    """Extract keys declared under [verifier.env] without a TOML parser.

    Reads only flat `key = "..."` lines inside the [verifier.env] table.
    aws-bench task.toml [verifier.env] blocks are always flat strings.
    """
    keys: set[str] = set()
    in_block = False
    for line in task_toml_text.splitlines():
        stripped = line.strip()
        if stripped == "[verifier.env]":
            in_block = True
            continue
        if in_block and stripped.startswith("[") and stripped.endswith("]"):
            break
        if in_block:
            m = re.match(r"^([A-Za-z0-9_\-]+)\s*=", stripped)
            if m:
                keys.add(m.group(1))
    return keys

tasks_dir = Path(sys.argv[1])
fail_count = 0
count = 0
for marker in sorted(tasks_dir.glob("*/*/tests/judge.toml")):
    task_dir = marker.parent.parent
    gt = task_dir / "tests" / "ground_truth.json"
    task_toml = task_dir / "task.toml"
    if not gt.exists() or not task_toml.exists():
        continue
    count += 1

    placeholders = set(re.findall(r"\{\{([^}]+)\}\}", gt.read_text()))
    if not placeholders:
        continue

    declared = verifier_env_keys(task_toml.read_text())

    missing = sorted(placeholders - declared)
    if missing:
        print(f"DRIFT: {task_dir}", file=sys.stderr)
        for k in missing:
            print(f"  undeclared: {k}", file=sys.stderr)
        fail_count += 1

if fail_count > 0:
    print(
        f"Found {fail_count} task(s) with undeclared placeholders out of {count} checked. "
        f"Run shared/judge/scripts/fix_verifier_env.py --apply to fix.",
        file=sys.stderr,
    )
    sys.exit(1)
print(f"Checked placeholder declarations in {count} rewardkit task(s); all declared.")
PYEOF
    exit $?
fi

# ── --check-output-contract: instruction.md schema vs check.py consumed keys ──
# Scoped to mutation tasks (presence of tests/check.py). Parses the JSON code
# fence from instruction.md (the `{...}` block following the
# "Additionally, write `/logs/agent/agent-output.json`" sentence) and compares
# its top-level keys against AGENT_OUTPUT.get("KEY") references in check.py.
if [[ "$MODE" == "check_output_contract" ]]; then
    python3 - "$TASKS_DIR" <<'PYEOF'
import json
import re
import sys
from pathlib import Path

tasks_dir = Path(sys.argv[1])
fail_count = 0
checked = 0

# Extract the first JSON object from a markdown ```json ... ``` fence following
# the agent-output.json contract sentence. Tolerates extra prose before/after.
JSON_FENCE_RE = re.compile(
    r"agent-output\.json[^\n]*\n+```json\s*\n(\{.*?\})\s*\n```",
    re.DOTALL,
)
# A check.py "consumes" a declared key if it reads it in any of the common
# idioms, not just AGENT_OUTPUT.get(): subscript access AGENT_OUTPUT["KEY"],
# membership tests "KEY" in AGENT_OUTPUT, and the REQUIRED_OUTPUT_KEYS = (...)
# tuple pattern that several checkers iterate with all(k in AGENT_OUTPUT ...).
# Recognizing only .get() produces false "declared-but-unconsumed" drift on
# tasks that use the other idioms (e.g. eks-deploy-nginx-via-alb) and, worse,
# could hide a genuinely undeclared key that check.py reads via subscript/in.
CONSUMED_KEY_RES = [
    re.compile(r"AGENT_OUTPUT\.get\(\s*['\"]([A-Za-z_][A-Za-z0-9_]*)['\"]"),
    re.compile(r"AGENT_OUTPUT\[\s*['\"]([A-Za-z_][A-Za-z0-9_]*)['\"]\s*\]"),
    re.compile(r"['\"]([A-Za-z_][A-Za-z0-9_]*)['\"]\s+in\s+AGENT_OUTPUT"),
]
# REQUIRED_OUTPUT_KEYS / REQUIRED_KEYS = ("A", "B") tuples/lists: pull every
# string literal inside the assignment's bracketed RHS.
REQUIRED_KEYS_BLOCK_RE = re.compile(
    r"REQUIRED(?:_OUTPUT)?_KEYS\s*[:=]\s*[\(\[](.*?)[\)\]]",
    re.DOTALL,
)
STRING_LITERAL_RE = re.compile(r"['\"]([A-Za-z_][A-Za-z0-9_]*)['\"]")


def consumed_keys(check_py_text: str) -> set:
    keys = set()
    for re_ in CONSUMED_KEY_RES:
        keys.update(re_.findall(check_py_text))
    for block in REQUIRED_KEYS_BLOCK_RE.findall(check_py_text):
        keys.update(STRING_LITERAL_RE.findall(block))
    return keys

for check_py in sorted(tasks_dir.glob("*/*/tests/check.py")):
    task_dir = check_py.parent.parent
    instruction_md = task_dir / "instruction.md"
    if not instruction_md.exists():
        continue
    md_text = instruction_md.read_text()
    m = JSON_FENCE_RE.search(md_text)
    if not m:
        # No agent-output.json contract declared. Skip — task may not need
        # structured output (e.g. all values come from CFN exports).
        # If check.py references AGENT_OUTPUT despite that, flag it.
        consumed = consumed_keys(check_py.read_text())
        if consumed:
            print(f"DRIFT: {task_dir}", file=sys.stderr)
            print(
                f"  check.py reads AGENT_OUTPUT keys but instruction.md "
                f"declares no agent-output.json contract: {sorted(consumed)}",
                file=sys.stderr,
            )
            fail_count += 1
            checked += 1
        continue
    checked += 1

    try:
        declared = set(json.loads(m.group(1)).keys())
    except json.JSONDecodeError as e:
        print(f"DRIFT: {task_dir}", file=sys.stderr)
        print(f"  instruction.md JSON fence is not valid JSON: {e}", file=sys.stderr)
        fail_count += 1
        continue

    consumed = consumed_keys(check_py.read_text())

    declared_only = declared - consumed
    consumed_only = consumed - declared
    if declared_only or consumed_only:
        print(f"DRIFT: {task_dir}", file=sys.stderr)
        if declared_only:
            print(
                f"  declared in instruction.md but not consumed in check.py: "
                f"{sorted(declared_only)}",
                file=sys.stderr,
            )
        if consumed_only:
            print(
                f"  consumed in check.py but not declared in instruction.md: "
                f"{sorted(consumed_only)}",
                file=sys.stderr,
            )
        fail_count += 1

if fail_count > 0:
    print(
        f"Found {fail_count} task(s) with output-contract drift out of {checked} checked.",
        file=sys.stderr,
    )
    sys.exit(1)
print(f"Checked output contracts in {checked} mutation task(s); all in sync.")
PYEOF
    exit $?
fi

# ── --check-trailers: instruction.md agent-contract trailer is canonical ──
if [[ "$MODE" == "check_trailers" ]]; then
    python3 - "$TASKS_DIR" <<'PYEOF'
import re
import sys
from pathlib import Path

INTROSPECTION_TRAILER = "IMPORTANT: Write your final answer to `/logs/agent/agent-output.txt`."
MUTATION_TRAILER = "IMPORTANT: Write your final prose answer to `/logs/agent/agent-output.txt`."

# End-anchored so stray prose after the JSON fence fails the check.
APPENDIX_RE = re.compile(
    r"\n+Additionally, write `/logs/agent/agent-output\.json` containing exactly:\s*\n+"
    r"```json\s*\n(?P<json>\{.*?\})\s*\n```\s*\Z",
    re.DOTALL,
)

REQUEST_TYPE_RE = re.compile(r'^request_type\s*=\s*"([^"]+)"\s*$', re.MULTILINE)

def read_request_type(task_toml_text: str) -> str | None:
    m = REQUEST_TYPE_RE.search(task_toml_text)
    return m.group(1) if m else None

tasks_dir = Path(sys.argv[1])
fail_count = 0
checked = 0

for task_toml in sorted(tasks_dir.glob("*/*/task.toml")):
    task_dir = task_toml.parent
    instruction_md = task_dir / "instruction.md"
    if not instruction_md.exists():
        continue
    checked += 1

    request_type = read_request_type(task_toml.read_text())
    if request_type not in ("introspection", "mutation"):
        print(f"DRIFT: {task_dir}", file=sys.stderr)
        print(f"  request_type={request_type!r}", file=sys.stderr)
        print("  expected trailer: (depends on request_type)", file=sys.stderr)
        print("  found:            (cannot validate — request_type missing or invalid)", file=sys.stderr)
        fail_count += 1
        continue

    text = instruction_md.read_text()
    if request_type == "mutation":
        appendix_match = APPENDIX_RE.search(text)
        if appendix_match:
            text = text[: appendix_match.start()]
    text = text.rstrip()

    expected = MUTATION_TRAILER if request_type == "mutation" else INTROSPECTION_TRAILER
    if not text.endswith(expected):
        # Use the LAST IMPORTANT line; earlier prose may contain its own.
        matches = re.findall(r"^IMPORTANT:.*$", text, re.MULTILINE)
        found = matches[-1] if matches else "(no IMPORTANT: line)"
        print(f"DRIFT: {task_dir}", file=sys.stderr)
        print(f"  request_type={request_type}", file=sys.stderr)
        print(f"  expected trailer: {expected!r}", file=sys.stderr)
        print(f"  found:            {found!r}", file=sys.stderr)
        fail_count += 1
        continue

    # Count the exact canonical trailer string (not any IMPORTANT: line)
    # so task bodies may use IMPORTANT: for emphasis.
    trailer_count = text.count(expected)
    if trailer_count > 1:
        print(f"DRIFT: {task_dir}", file=sys.stderr)
        print(f"  request_type={request_type}", file=sys.stderr)
        print(f"  found {trailer_count} occurrences of the canonical trailer, expected exactly 1", file=sys.stderr)
        fail_count += 1

if fail_count > 0:
    print(
        f"Found {fail_count} task(s) with trailer drift out of {checked} checked.",
        file=sys.stderr,
    )
    sys.exit(1)
print(f"Checked agent-contract trailer in {checked} task(s); all in sync.")
PYEOF
    exit $?
fi

# ── --check / sync: shared/judge/ files across all tasks ──
# A task's judge.toml/judge_prompt.md are "customized" once a per-claim rubric
# has replaced the canonical single "answers_equivalent" criterion. Detect
# this without a TOML parser: the canonical judge.toml always has exactly
# that one criterion name; any task missing that exact line has been
# regenerated into per-claim criteria. test.sh and resolve_placeholders.py
# are never touched by that customization, so they always stay canonical
# regardless of whether the task's judge files were
# customized.
is_customized() {
    ! grep -q '^name = "answers_equivalent"$' "$1/judge.toml" 2>/dev/null
}

ALWAYS_SYNCED_FILES=(test.sh resolve_placeholders.py)

count=0
customized_count=0
diff_count=0
while IFS= read -r -d '' marker; do
    task_tests_dir="$(dirname "$marker")"
    if is_customized "$task_tests_dir"; then
        customized_count=$((customized_count + 1))
        sync_files=("${ALWAYS_SYNCED_FILES[@]}")
    else
        sync_files=("${FILES[@]}")
    fi
    for f in "${sync_files[@]}"; do
        if [[ "$MODE" == "check" ]]; then
            if ! cmp -s "$SHARED_DIR/$f" "$task_tests_dir/$f"; then
                echo "DRIFT: $task_tests_dir/$f differs from $SHARED_DIR/$f" >&2
                diff_count=$((diff_count + 1))
            fi
        else
            cp "$SHARED_DIR/$f" "$task_tests_dir/$f"
        fi
    done
    count=$((count + 1))
done < <(find "$TASKS_DIR" -name 'judge.toml' -path '*/tests/judge.toml' -print0)

canonical_count=$((count - customized_count))
if [[ "$MODE" == "check" ]]; then
    if [[ $diff_count -gt 0 ]]; then
        echo "Found $diff_count drifted file(s) across $count task(s). Run sync.sh to fix." >&2
        exit 1
    fi
    echo "Checked ${#FILES[@]} files in $canonical_count canonical task(s) + ${#ALWAYS_SYNCED_FILES[@]} files in $customized_count customized task(s) ($count total); all in sync."
else
    echo "Synced ${#FILES[@]} files into $canonical_count canonical task(s), ${#ALWAYS_SYNCED_FILES[@]} files (test.sh/resolve_placeholders.py only) into $customized_count customized task(s) ($count total)."
fi
