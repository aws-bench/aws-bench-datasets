#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate the two scope-filtered, harbor-loadable rubrics from the canonical one.

`harbor check` judges every criterion in the rubric it is handed, so an introspection
task handed the full rubric gets graded on mutation-only criteria too (the judge guesses
instead of returning not_applicable). We avoid that by handing each task the rubric for
its type: introspection gets scope in {both, introspection}; mutation gets {both, mutation}.

Both files derive entirely from rubrics/task-implementation.toml. They carry only the
fields harbor reads (name, description, guidance); severity and scope stay in the canonical
file, where the aggregator reads them. These scoped files are NOT committed: they are a
build artifact. judge.py calls write_scoped_rubrics() to produce them fresh inside each run
folder, so a run records the exact rubric it used and the repo never carries a derived copy
that could drift from the canonical source.

This script is a thin standalone wrapper around that same function, for inspecting the
scoped output by hand. Point it at any directory.

Usage:
    uv run tools/rubric-runner/generate_rubrics.py --out-dir /tmp/scoped-rubrics
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import TASK_TYPES, Criterion, RESULTS_ROOT, load_criteria  # noqa: E402

HEADER = """\
# GENERATED from rubrics/task-implementation.toml by the rubric runner. Do not edit by
# hand: edit the canonical rubric instead. This file holds the criteria that apply to
# {task_type} tasks (scope = both or {task_type}), with only the fields harbor reads.
"""


def _toml_basic_string(value: str) -> str:
    r"""Encode a string as a TOML basic string (escaping \\, ", control chars)."""
    out = []
    for ch in value:
        if ch == "\\":
            out.append("\\\\")
        elif ch == '"':
            out.append('\\"')
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\t":
            out.append("\\t")
        elif ch == "\r":
            out.append("\\r")
        elif ord(ch) < 0x20:
            out.append(f"\\u{ord(ch):04x}")
        else:
            out.append(ch)
    return '"' + "".join(out) + '"'


def render(task_type: str, criteria: list[Criterion]) -> str:
    applicable = [c for c in criteria if c.applies_to(task_type)]
    lines = [HEADER.format(task_type=task_type)]
    for c in applicable:
        lines.append("[[criteria]]")
        lines.append(f"name = {_toml_basic_string(c.name)}")
        lines.append(f"description = {_toml_basic_string(c.description)}")
        # guidance is multi-line; a TOML multi-line basic string keeps it readable.
        guidance = c.guidance.replace("\\", "\\\\").replace('"""', '\\"\\"\\"')
        lines.append(f'guidance = """\n{guidance}\n"""')
        lines.append("")
    return "\n".join(lines) + "\n"


def scoped_rubric_path(out_dir: Path, task_type: str) -> Path:
    """Where the scoped rubric for a task type lives inside a given output dir."""
    return out_dir / f"task-implementation-{task_type}.toml"


def write_scoped_rubrics(
    out_dir: Path, criteria: list[Criterion] | None = None
) -> dict[str, Path]:
    """Write both scope-filtered rubrics into out_dir; return {task_type: path}.

    Called by judge.py to materialize the rubrics harbor will read, fresh for each run.
    """
    if criteria is None:
        criteria = load_criteria()
    out_dir.mkdir(parents=True, exist_ok=True)
    written = {}
    for t in TASK_TYPES:
        path = scoped_rubric_path(out_dir, t)
        path.write_text(render(t, criteria))
        written[t] = path
    return written


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--out-dir",
        default=str(RESULTS_ROOT / "_scoped-rubrics-preview"),
        help="directory to write the two scoped rubrics into "
        "(default: a preview dir under rubric-results/)",
    )
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    written = write_scoped_rubrics(out_dir)
    for t, path in written.items():
        n = path.read_text().count("[[criteria]]")
        print(f"wrote {path} ({n} criteria)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
