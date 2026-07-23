"""Shared helpers for the aws-bench implementation-rubric tooling.

Stdlib only (tomllib, json, pathlib), so any script that imports this can declare
just its external deps in its own PEP 723 header. This module owns the two facts
the rest of the tooling must agree on: how a task's type is detected, and what the
canonical rubric says about each criterion's severity and scope.

Task type is detected from files, never from a metadata field, matching the CI
suite (test/test_tasks.ts): introspection has tests/judge.toml + tests/ground_truth.json;
mutation has tests/check.py. The two sets are disjoint across the dataset.
"""

from __future__ import annotations

import json
import tomllib
from dataclasses import dataclass
from pathlib import Path

# Repo root is three levels up from this file: tools/rubric-runner/lib.py -> repo.
REPO_ROOT = Path(__file__).resolve().parents[2]
TASKS_DIR = REPO_ROOT / "tasks"
SCENARIOS_DIR = REPO_ROOT / "scenarios"
CANONICAL_RUBRIC = REPO_ROOT / "rubrics" / "task-implementation.toml"

# All run output lands under one parent dir, one timestamped folder per run. A single
# run folder holds the run-level files (_run.json, run.log, and after aggregate/report
# summary.json, findings.md, report.html) at its top, with the many per-task <slug>.json
# dumps tucked into a per-task/ subfolder so the run folder stays readable.
RESULTS_ROOT = Path(__file__).resolve().parent / "rubric-results"
PER_TASK_DIRNAME = "per-task"


def per_task_dir(run_dir: Path) -> Path:
    """The subfolder of a run holding the individual <slug>.json result files."""
    return run_dir / PER_TASK_DIRNAME


def new_run_dir(results_root: Path = RESULTS_ROOT, stamp: str | None = None) -> Path:
    """Create and return a fresh timestamped run folder under the results root.

    The caller passes the stamp (scripts cannot use the wall clock freely under some
    harnesses); when omitted we fall back to the local time. Format is filesystem-safe
    and lexically sortable: YYYY-MM-DDTHH-MM-SS.
    """
    if stamp is None:
        from datetime import datetime

        stamp = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    run_dir = results_root / stamp
    run_dir.mkdir(parents=True, exist_ok=True)
    return run_dir


def latest_run_dir(results_root: Path = RESULTS_ROOT) -> Path | None:
    """The most recent run folder under the results root, or None if there are none."""
    if not results_root.is_dir():
        return None
    runs = [
        p for p in results_root.iterdir() if p.is_dir() and (p / "_run.json").is_file()
    ]
    if not runs:
        # Fall back to any subdirectory (e.g. a run that errored before _run.json).
        runs = [p for p in results_root.iterdir() if p.is_dir()]
    return max(runs, key=lambda p: p.name) if runs else None


def resolve_run_dir(run_dir_arg: str | None, results_root: Path = RESULTS_ROOT) -> Path:
    """Pick the run folder a read-side tool (aggregate/report) should act on.

    An explicit --run-dir wins; otherwise use the latest run under the results root.
    Raises SystemExit with a helpful message when neither is available.
    """
    if run_dir_arg:
        p = Path(run_dir_arg)
        if not p.is_dir():
            raise SystemExit(f"run dir not found: {p}")
        return p
    latest = latest_run_dir(results_root)
    if latest is None:
        raise SystemExit(
            f"no run folders under {results_root}. Run judge.py first, "
            f"or pass --run-dir."
        )
    return latest


# The two task types aws-bench has, detected from files (see detect_task_type).
TASK_TYPES = ("introspection", "mutation")

# A criterion's scope decides which task types it binds. "both" runs on every task;
# the others run only on their type. The label severity sits outside per-task scoring.
SCOPES = ("both", "introspection", "mutation")
SEVERITIES = ("blocker", "major", "minor", "label")
# Canonical ordering of severities, most severe first (for sorting columns/findings).
SEVERITY_ORDER = {sev: i for i, sev in enumerate(SEVERITIES)}


def outcome_str(outcome) -> str:
    """Normalize a check outcome to its lowercase string value.

    harbor outcomes are a CheckOutcome(str, Enum); persisted JSON may carry a plain
    string or, defensively, an enum-shaped {"value": ...} dict. All collapse to the
    string ("pass" / "fail" / "not_applicable")."""
    if isinstance(outcome, dict) and "value" in outcome:
        return outcome["value"]
    return outcome.value if hasattr(outcome, "value") else str(outcome)


def load_task_results(per_task_dir: Path) -> list[dict]:
    """Load every per-task verdict file (<slug>.json holding a 'checks' object)."""
    out = []
    for path in sorted(per_task_dir.glob("*.json")):
        data = json.loads(path.read_text())
        if "checks" in data:
            out.append(data)
    return out


@dataclass(frozen=True)
class Criterion:
    name: str
    severity: str
    scope: str
    description: str
    guidance: str

    def applies_to(self, task_type: str) -> bool:
        """True if this criterion should be judged for a task of the given type."""
        return self.scope == "both" or self.scope == task_type


def load_criteria(rubric_path: Path = CANONICAL_RUBRIC) -> list[Criterion]:
    """Parse the canonical rubric into Criterion records, validating each field."""
    data = tomllib.loads(rubric_path.read_text())
    out: list[Criterion] = []
    for raw in data.get("criteria", []):
        for field in ("name", "severity", "scope", "description", "guidance"):
            if field not in raw:
                raise ValueError(f"criterion {raw.get('name', '?')} missing '{field}'")
        if raw["severity"] not in SEVERITIES:
            raise ValueError(f"{raw['name']}: bad severity {raw['severity']!r}")
        if raw["scope"] not in SCOPES:
            raise ValueError(f"{raw['name']}: bad scope {raw['scope']!r}")
        out.append(
            Criterion(
                name=raw["name"],
                severity=raw["severity"],
                scope=raw["scope"],
                description=raw["description"].strip(),
                guidance=raw["guidance"].strip(),
            )
        )
    if not out:
        raise ValueError(f"no criteria found in {rubric_path}")
    return out


def detect_task_type(task_dir: Path) -> str:
    """Return 'introspection', 'mutation', or 'unknown' from the task's files."""
    tests = task_dir / "tests"
    has_judge = (tests / "judge.toml").is_file() and (
        tests / "ground_truth.json"
    ).is_file()
    has_check = (tests / "check.py").is_file()
    if has_check and not has_judge:
        return "mutation"
    if has_judge and not has_check:
        return "introspection"
    return "unknown"


def list_task_dirs(tasks_dir: Path = TASKS_DIR) -> list[Path]:
    """Every task directory under tasks/<category>/<task> that holds a task.toml."""
    out: list[Path] = []
    for category in sorted(p for p in tasks_dir.iterdir() if p.is_dir()):
        for task in sorted(p for p in category.iterdir() if p.is_dir()):
            if (task / "task.toml").is_file():
                out.append(task)
    return out


def task_slug(task_dir: Path, tasks_dir: Path = TASKS_DIR) -> str:
    """Stable filesystem-safe id for a task: '<category>__<task>'."""
    rel = task_dir.resolve().relative_to(tasks_dir.resolve())
    return "__".join(rel.parts)
