# rubric-runner

The LLM implementation-rubric tooling for aws-bench tasks. It reads each task's files
and judges them against `rubrics/task-implementation.toml`, one verdict per criterion,
then aggregates those verdicts into a per-task alignment result and a report. It is a
static read: it never deploys, runs, or mutates a task or any AWS resource.

This is the quality layer that judges the *quality of a built task*. It is separate from
the deterministic CI checks in `test/` (schema, paths, roles, canary, and the like), which
run on every PR. This tool is heavier (it calls a model, needs network and AWS credentials)
and is run on demand, not as a per-PR gate.

It does **not** do proposal grading. There is a separate practice in some benchmarks of
scoring a task *idea* (its `instruction.md`) against a coarse accept/reject decision before
the task is built. aws-bench tasks already exist, so we do not do that, and none of that
logic is here.

## Layout

```
tools/rubric-runner/
  run.sh                 # end-to-end: judge -> aggregate -> report in one command
  judge.py               # run `harbor check` per task -> a new timestamped run folder
  aggregate.py           # apply the standard's rules -> summary.json, findings.md (in the run folder)
  report.py              # render summary.json -> report.html (self-contained, in the run folder)
  generate_rubrics.py    # render the two scope-filtered rubrics from the canonical one (judge.py calls this)
  lib.py                 # shared: task-type detection, canonical-rubric loading, run-folder layout (stdlib only)
  rubric-results/        # GENERATED run output (git-ignored); one timestamped folder per run
    2026-06-25T21-10-25/
      rubrics/           # the two scope-filtered rubrics this run judged against
      per-task/          # the per-task <slug>.json verdicts
      _run.json          # run record
      run.log            # console log of the run
      summary.json       # aggregated (aggregate.py)
      findings.md        # failures grouped by criterion (aggregate.py)
      report.html        # sortable grid (report.py)
rubrics/
  task-implementation.toml            # the canonical rubric (source of truth; hand-edited)
  evaluator-prompt.txt                # the prompt handed to the judge
```

Each script is a self-contained `uv run` script with PEP 723 inline dependencies, mirroring
how Terminal Bench 3 packages its `tools/`. There is no repo-level `pyproject.toml`; you need
only a working `uv` on PATH. `judge.py` pulls `harbor==0.9.0` from PyPI on first run (cached by uv).

## Prerequisites

- `uv` on PATH.
- Model access through Bedrock, the same credentials a developer already needs to run
  aws-bench: an AWS profile (or other standard credential chain) with Bedrock access. The
  runner sets `CLAUDE_CODE_USE_BEDROCK=1` and a placeholder `ANTHROPIC_API_KEY` for you if
  unset (harbor checks that the variable is present but never validates it; traffic still
  routes to Bedrock, never to the Anthropic API). It does not manage AWS credentials: pick
  the account by setting `AWS_PROFILE` inline (e.g. `AWS_PROFILE=my-bedrock uv run ...`),
  which uv passes through, or rely on whatever profile your shell already exports. The
  resolved profile and region are recorded in the run folder's `_run.json`.
- Nothing else on the host: `harbor` is pulled by uv, and it ships its own bundled `claude`
  binary (under its `claude_agent_sdk`), so the judge does not depend on a `claude` CLI being
  installed on the host.

## Usage

The fastest path is the end-to-end wrapper, which judges, aggregates, and reports in one
command. Set `AWS_PROFILE` inline to choose the Bedrock account (or rely on your shell's),
and pass any `judge.py` arguments straight through:

```bash
AWS_PROFILE=my-bedrock tools/rubric-runner/run.sh
AWS_PROFILE=my-bedrock tools/rubric-runner/run.sh --model us.anthropic.claude-sonnet-4-6 --concurrency 12
AWS_PROFILE=my-bedrock tools/rubric-runner/run.sh --type introspection
```

Or run the three steps yourself (each is a self-contained `uv run` script):

```bash
# 1. Judge tasks. Default is every stable task; scope with --tasks or --type.
AWS_PROFILE=my-bedrock uv run tools/rubric-runner/judge.py --tasks tasks/serverless-apps/check-s-buckets-public-access
uv run tools/rubric-runner/judge.py --type introspection
uv run tools/rubric-runner/judge.py                          # whole stable dataset

# 2. Aggregate the raw verdicts into alignment results.
uv run tools/rubric-runner/aggregate.py            # defaults to the latest run

# 3. Render the HTML report.
uv run tools/rubric-runner/report.py --open        # defaults to the latest run
```

Each `judge.py` invocation creates a fresh timestamped folder under
`tools/rubric-runner/rubric-results/` (git-ignored) and writes everything for that run into
it: the two scope-filtered rubrics it judged against under `rubrics/` (generated fresh from
the canonical rubric, so the run records the exact bar it used), the per-task `<slug>.json`
verdicts under `per-task/`, plus `_run.json` (run record) and `run.log` (console log) at the
folder's top. `aggregate.py` and `report.py` default to the latest run folder (pass
`--run-dir DIR` to target a specific one) and write `summary.json`, `findings.md`, and
`report.html` alongside, at the run folder's top. To resume or re-judge into an existing run
instead of creating a new one, pass `judge.py --run-dir DIR` (with `--force` to overwrite
already-judged tasks).

There is no separate "regenerate the rubrics" step: `judge.py` generates the scope-filtered
rubrics itself at the start of every run. To inspect them without a full run, point the
generator at any directory: `uv run tools/rubric-runner/generate_rubrics.py --out-dir /tmp/scoped`.

## How scope is honored

`harbor check` judges every criterion in the rubric it is given, so an introspection task
handed the full rubric would be scored on mutation-only criteria too (the judge guesses
instead of returning `not_applicable`). To avoid that, `judge.py` renders one rubric per task
type into the run folder at startup (introspection gets `scope` in `{both, introspection}`;
mutation gets `{both, mutation}`) and hands each task the rubric for its detected type. Task
type is detected from files, never from a metadata field, matching `test/test_tasks.ts`:
introspection has `tests/judge.toml` + `tests/ground_truth.json`; mutation has `tests/check.py`.

## How aggregation decides "aligned"

From the quality standard:

- A task is **aligned** iff no `blocker` criterion failed.
- `major` / `minor` fails are scored, not gating: reported as counts and per-criterion rates.
- `not_applicable` drops out of the denominator, so a pass rate is over applicable tasks only.
- The `label` criterion (`non_guessable_answer`) is not scored per task. Its classifications
  are aggregated across the introspection set and held to a dataset-level cap (the share of
  trivial-negative answers must stay under the threshold; default 0.30, set with `--label-cap`).

## Not yet built

- **Grader validation** (precision/recall of the judge against human labels) is the calibration
  step that licenses trusting these numbers at the dataset level. It is the next piece to build,
  modeled on Terminal Bench 3's `tools/rubric-tuning/run_eval.py`.
- **Holistic review** (a deep, prose review per task) is deferred: it feeds on live trial
  artifacts (oracle/nop and multi-trial runs), which do not exist until the execution gates are built.
