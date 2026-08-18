#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["harbor==0.9.0"]
# ///
"""Run the implementation rubric over aws-bench tasks with `harbor check`.

For each task, this picks the rubric for the task's type (introspection or mutation),
runs `harbor check` as a read-only static judgment through Bedrock, and writes the raw
per-criterion verdicts. It judges; it does not deploy or run tasks. Aggregation into
alignment verdicts is a separate step (aggregate.py).

Each invocation creates one timestamped run folder under rubric-results/ and owns its
whole layout: the per-task <slug>.json verdicts go in a per-task/ subfolder, while the
run-level files (_run.json, run.log, and later summary.json, findings.md, report.html
from aggregate.py and report.py) sit at the run folder's top. --run-dir resumes an
existing folder instead of creating a new one.

Model access: harbor shells out to the `claude` CLI, which reaches Claude on Bedrock
when CLAUDE_CODE_USE_BEDROCK=1 and AWS credentials are present (the same credentials a
developer already needs to run aws-bench). harbor guards on the presence of
ANTHROPIC_API_KEY but never validates it, so we set a placeholder if one is absent;
traffic still routes to Bedrock. Nothing here hits the Anthropic API.

This tool does not manage AWS credentials; it inherits the ambient credential chain.
Choose the Bedrock account/identity by setting AWS_PROFILE inline on the command, which
uv passes through to the run (and on to the claude CLI). If AWS_PROFILE is already
exported in your shell, you can omit it. The resolved profile/region are recorded in
the run folder's _run.json.

Usage:
    AWS_PROFILE=my-bedrock-profile uv run tools/rubric-runner/judge.py   # all stable tasks
    uv run tools/rubric-runner/judge.py --tasks tasks/serverless-apps/check-s-buckets-public-access
    uv run tools/rubric-runner/judge.py --type introspection            # only introspection tasks
    uv run tools/rubric-runner/judge.py --model us.anthropic.claude-sonnet-4-5-20250929-v1:0
    uv run tools/rubric-runner/judge.py --concurrency 8 --force
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate_rubrics import write_scoped_rubrics  # noqa: E402
from lib import (  # noqa: E402
    CANONICAL_RUBRIC,
    REPO_ROOT,
    TASK_TYPES,
    detect_task_type,
    list_task_dirs,
    new_run_dir,
    outcome_str,
    per_task_dir,
    task_slug,
)

PROMPT_PATH = REPO_ROOT / "rubrics" / "evaluator-prompt.txt"
# A Bedrock inference-profile id, not the Anthropic alias, so the CLI resolves it directly.
DEFAULT_MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
DEFAULT_CONCURRENCY = 8


class _Tee:
    """Mirror writes to the real stream and a log file, so the run's console output
    is captured inside its own run folder without needing a shell redirect."""

    def __init__(self, stream, log_handle):
        self._stream = stream
        self._log = log_handle

    def write(self, data):
        self._stream.write(data)
        self._log.write(data)
        # Flush on every write so the run log and console can be tailed live during a
        # long run, rather than appearing only when the process exits.
        self._stream.flush()
        self._log.flush()
        return len(data)

    def flush(self):
        self._stream.flush()
        self._log.flush()


def ensure_bedrock_env() -> None:
    """Make the process environment route harbor's `claude` calls to Bedrock."""
    os.environ.setdefault("CLAUDE_CODE_USE_BEDROCK", "1")
    # harbor hard-raises if ANTHROPIC_API_KEY is unset; it only checks presence.
    os.environ.setdefault("ANTHROPIC_API_KEY", "bedrock-placeholder-unused")
    os.environ.setdefault(
        "AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
    )


async def judge_one(
    task_dir: Path,
    model: str,
    tasks_out_dir: Path,
    rubric_paths: dict[str, Path],
    sem: asyncio.Semaphore,
    force: bool,
) -> dict:
    """Run harbor check on one task; persist and return a small status record."""
    # Imported lazily so --help works without harbor installed.
    from harbor.analyze.checker import run_check  # ty: ignore[unresolved-import]

    slug = task_slug(task_dir)
    task_type = detect_task_type(task_dir)
    out_path = tasks_out_dir / f"{slug}.json"
    rec = {
        "slug": slug,
        "task": str(task_dir.relative_to(REPO_ROOT)),
        "type": task_type,
    }

    if task_type == "unknown":
        rec["status"] = "skipped"
        rec["reason"] = (
            "cannot detect task type (need tests/judge.toml+ground_truth.json or tests/check.py)"
        )
        return rec
    if out_path.is_file() and not force:
        rec["status"] = "cached"
        return rec

    rubric_path = rubric_paths[task_type]
    async with sem:
        started = time.monotonic()
        try:
            result = await run_check(
                task_dir=task_dir,
                model=model,
                rubric_path=rubric_path,
                prompt_path=PROMPT_PATH,
            )
        except Exception as e:  # noqa: BLE001 - record the failure, keep the batch going
            rec["status"] = "error"
            rec["reason"] = f"{type(e).__name__}: {e}"
            rec["elapsed_sec"] = round(time.monotonic() - started, 1)
            return rec

    # result.checks is dict[str, QualityCheckModel]; flatten to the same
    # {outcome, explanation} shape harbor's own `-o` writer emits.
    checks = {
        name: {"outcome": outcome_str(c.outcome), "explanation": c.explanation}
        for name, c in result.checks.items()
    }
    payload = {
        "slug": slug,
        "task": str(task_dir.relative_to(REPO_ROOT)),
        "type": task_type,
        "model": model,
        # The scoped rubric lives inside this run folder (tasks_out_dir is <run>/per-task),
        # so record it relative to the run dir. That stays valid wherever the run dir is,
        # including a --run-dir outside the repo.
        "rubric": str(rubric_path.relative_to(tasks_out_dir.parent)),
        "checks": checks,
    }
    out_path.write_text(json.dumps(payload, indent=2) + "\n")
    rec["status"] = "ok"
    rec["elapsed_sec"] = round(time.monotonic() - started, 1)
    rec["n_criteria"] = len(checks)
    return rec


def select_tasks(args) -> list[Path]:
    if args.tasks:
        dirs = [(REPO_ROOT / t).resolve() for t in args.tasks]
        for d in dirs:
            if not (d / "task.toml").is_file():
                raise SystemExit(f"not a task directory (no task.toml): {d}")
    else:
        dirs = list_task_dirs()
    if args.type:
        dirs = [d for d in dirs if detect_task_type(d) == args.type]
    return dirs


async def run(args, run_dir: Path) -> int:
    tasks = select_tasks(args)
    if not tasks:
        print("No matching tasks.", file=sys.stderr)
        return 1

    # Generate the scope-filtered rubrics harbor will read, fresh into this run folder,
    # so the run records the exact rubric it used and nothing derived is committed.
    rubric_paths = write_scoped_rubrics(run_dir / "rubrics")

    ensure_bedrock_env()
    aws_profile = os.environ.get("AWS_PROFILE", "(default credential chain)")
    aws_region = os.environ.get("AWS_REGION", "")
    sem = asyncio.Semaphore(args.concurrency)
    print(
        f"Judging {len(tasks)} task(s) with model {args.model} via Bedrock\n"
        f"  AWS_PROFILE={aws_profile}  AWS_REGION={aws_region}\n"
        f"  concurrency {args.concurrency}, run dir -> {run_dir}"
    )

    # Per-task dumps go in a subfolder; run-level files stay at the run-dir top.
    tasks_out_dir = per_task_dir(run_dir)
    tasks_out_dir.mkdir(parents=True, exist_ok=True)

    done = 0
    total = len(tasks)
    coros = [
        judge_one(t, args.model, tasks_out_dir, rubric_paths, sem, args.force)
        for t in tasks
    ]
    records: list[dict] = []
    for fut in asyncio.as_completed(coros):
        rec = await fut
        records.append(rec)
        done += 1
        status = rec["status"]
        extra = ""
        if status == "ok":
            extra = f"{rec['elapsed_sec']}s, {rec['n_criteria']} criteria"
        elif status in ("error", "skipped"):
            extra = rec.get("reason", "")
        print(f"[{done}/{total}] {status:8} {rec['slug']}  {extra}")

    summary = {
        "run": run_dir.name,
        "model": args.model,
        "aws_profile": aws_profile,
        "aws_region": aws_region,
        "total": total,
        "ok": sum(r["status"] == "ok" for r in records),
        "cached": sum(r["status"] == "cached" for r in records),
        "errors": sum(r["status"] == "error" for r in records),
        "skipped": sum(r["status"] == "skipped" for r in records),
        "records": sorted(records, key=lambda r: r["slug"]),
    }
    (run_dir / "_run.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(
        f"\nDone. ok={summary['ok']} cached={summary['cached']} "
        f"errors={summary['errors']} skipped={summary['skipped']}. "
        f"Run dir: {run_dir}\n"
        f"Next: uv run tools/rubric-runner/aggregate.py   "
        f"(defaults to this latest run), then report.py"
    )
    return 1 if summary["errors"] else 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--tasks",
        nargs="+",
        metavar="DIR",
        help="task directories to judge (default: all stable tasks)",
    )
    ap.add_argument("--type", choices=TASK_TYPES, help="restrict to one task type")
    ap.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"Bedrock model id (default: {DEFAULT_MODEL})",
    )
    ap.add_argument(
        "--concurrency",
        type=int,
        default=DEFAULT_CONCURRENCY,
        help=f"max concurrent harbor checks (default: {DEFAULT_CONCURRENCY})",
    )
    ap.add_argument(
        "--run-dir",
        metavar="DIR",
        help="resume into an existing run folder (default: create a new "
        "timestamped folder under rubric-results/)",
    )
    ap.add_argument(
        "--force",
        action="store_true",
        help="re-judge tasks even if a result file already exists in the run dir",
    )
    args = ap.parse_args()

    if not PROMPT_PATH.is_file():
        raise SystemExit(f"evaluator prompt not found: {PROMPT_PATH}")
    if not CANONICAL_RUBRIC.is_file():
        raise SystemExit(f"canonical rubric not found: {CANONICAL_RUBRIC}")

    # The runner owns the layout: one timestamped folder per run under rubric-results/,
    # holding every artifact for that run (per-task JSON, _run.json, run.log, and later
    # the aggregate/report output). --run-dir resumes an existing folder instead.
    if args.run_dir:
        run_dir = Path(args.run_dir)
        run_dir.mkdir(parents=True, exist_ok=True)
    else:
        run_dir = new_run_dir()

    log_path = run_dir / "run.log"
    with log_path.open("w") as log_handle:
        orig_out, orig_err = sys.stdout, sys.stderr
        sys.stdout = _Tee(orig_out, log_handle)  # type: ignore[assignment]
        sys.stderr = _Tee(orig_err, log_handle)  # type: ignore[assignment]
        try:
            return asyncio.run(run(args, run_dir))
        finally:
            sys.stdout, sys.stderr = orig_out, orig_err


if __name__ == "__main__":
    raise SystemExit(main())
