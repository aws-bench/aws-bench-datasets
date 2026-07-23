#!/usr/bin/env bash
# End-to-end rubric run: judge every task, aggregate the verdicts, render the report.
#
# This chains the three steps that normally run in sequence:
#   1. judge.py        judge tasks -> a new timestamped run folder under rubric-results/
#   2. aggregate.py  apply the standard's rules -> summary.json, findings.md (latest run)
#   3. report.py     render the sortable HTML grid -> report.html (latest run)
#
# Steps 2 and 3 default to the latest run, so they pick up the folder step 1 just created.
# Any arguments you pass are forwarded to judge.py, so the usual run controls work here too:
#
#   AWS_PROFILE=my-bedrock tools/rubric-runner/run.sh
#   AWS_PROFILE=my-bedrock tools/rubric-runner/run.sh --model us.anthropic.claude-sonnet-4-6 --concurrency 12
#   AWS_PROFILE=my-bedrock tools/rubric-runner/run.sh --type introspection
#
# Set AWS_PROFILE inline (or rely on your shell's) to choose the Bedrock account, exactly
# as with judge.py. Requires uv on PATH; nothing else.
set -euo pipefail

# Resolve the runner dir from this script's own location, so it works from any cwd.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> [1/3] judging tasks (judge.py)"
uv run "$HERE/judge.py" "$@"

echo
echo "==> [2/3] aggregating verdicts (aggregate.py, latest run)"
uv run "$HERE/aggregate.py"

echo
echo "==> [3/3] rendering report (report.py, latest run)"
uv run "$HERE/report.py"

echo
echo "Done. All three steps complete; outputs are in the latest run folder under"
echo "  $HERE/rubric-results/"
