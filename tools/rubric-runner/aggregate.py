#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Aggregate raw rubric verdicts into alignment results, per the quality standard.

Reads the per-task <slug>.json files written by judge.py (under a run folder's per-task/
subfolder), joins each verdict to the canonical rubric's severity and scope, and applies
the standard's rules:

  - A task is ALIGNED iff no blocker criterion failed.
  - major / minor fails are scored, not gating; reported as counts and per-criterion rates.
  - not_applicable drops out of the denominator, so a rate is over applicable tasks only.
  - label criteria (non_guessable_answer) sit outside per-task scoring. Their classifications
    are aggregated across the introspection set and held to a dataset-level cap: the share of
    trivial-negative answers must stay under the threshold.

Out-of-scope verdicts are dropped defensively: judge.py already hands each task only its
scoped rubric, but if a result carries a criterion that does not apply to the task's type,
it is ignored here so it can never affect a verdict.

Outputs (written to the top of the run folder): summary.json (machine-readable), findings.md
(failures grouped by criterion, the actionable list), and a console summary. report.py then
renders the same run folder to HTML.

Usage:
    uv run tools/rubric-runner/aggregate.py                       # the latest run
    uv run tools/rubric-runner/aggregate.py --run-dir DIR --label-cap 0.30
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import (  # noqa: E402
    SEVERITY_ORDER,
    load_criteria,
    load_task_results,
    outcome_str,
    per_task_dir,
    resolve_run_dir,
)

# Share of trivial-negative introspection answers above which the set is "too guessable".
DEFAULT_LABEL_CAP = 0.30
PASS, FAIL, NA = "pass", "fail", "not_applicable"


def aggregate(results: list[dict], criteria: dict, label_cap: float) -> dict:
    label_names = {c.name for c in criteria.values() if c.severity == "label"}

    # Per-criterion tallies over the tasks the criterion actually applied to.
    tally: dict[str, dict[str, int]] = defaultdict(lambda: {PASS: 0, FAIL: 0, NA: 0})
    # Per-task verdict records.
    tasks: list[dict] = []
    # Failures grouped by criterion for the findings report.
    failures: dict[str, list[dict]] = defaultdict(list)
    # Label classifications across introspection tasks.
    label_negatives = 0
    label_total = 0

    for res in results:
        slug, ttype = res["slug"], res["type"]
        blocker_fails, major_fails, minor_fails = [], [], []
        for name, check in res["checks"].items():
            crit = criteria.get(name)
            if crit is None or not crit.applies_to(ttype):
                continue  # unknown or out-of-scope: never scored
            outcome = outcome_str(check.get("outcome"))
            explanation = check.get("explanation", "")

            if crit.severity == "label":
                # Labels are classified, not scored. fail == trivial-negative answer.
                if outcome in (PASS, FAIL):
                    label_total += 1
                    if outcome == FAIL:
                        label_negatives += 1
                continue

            if outcome not in (PASS, FAIL, NA):
                outcome = NA  # defensive: treat malformed as not-applicable
            tally[name][outcome] += 1
            if outcome == FAIL:
                bucket = {
                    "blocker": blocker_fails,
                    "major": major_fails,
                    "minor": minor_fails,
                }[crit.severity]
                bucket.append(name)
                failures[name].append(
                    {"slug": slug, "type": ttype, "explanation": explanation}
                )

        tasks.append(
            {
                "slug": slug,
                "type": ttype,
                "aligned": len(blocker_fails) == 0,
                "blocker_fails": sorted(blocker_fails),
                "major_fails": sorted(major_fails),
                "minor_fails": sorted(minor_fails),
            }
        )

    per_criterion = {}
    for name, crit in criteria.items():
        if crit.severity == "label":
            continue
        t = tally[name]
        applicable = t[PASS] + t[FAIL]  # not_applicable excluded from the denominator
        per_criterion[name] = {
            "severity": crit.severity,
            "scope": crit.scope,
            "pass": t[PASS],
            "fail": t[FAIL],
            "not_applicable": t[NA],
            "applicable": applicable,
            "pass_rate": round(t[PASS] / applicable, 4) if applicable else None,
        }

    aligned = sum(1 for t in tasks if t["aligned"])
    label_share = round(label_negatives / label_total, 4) if label_total else None
    summary = {
        "total_tasks": len(tasks),
        "aligned": aligned,
        "not_aligned": len(tasks) - aligned,
        "by_type": _count_by_type(tasks),
        "per_criterion": per_criterion,
        "label_metric": {
            "criterion": sorted(label_names),
            "negatives": label_negatives,
            "classified": label_total,
            "negative_share": label_share,
            "cap": label_cap,
            "within_cap": (label_share is None) or (label_share <= label_cap),
        },
        "tasks": sorted(tasks, key=lambda t: t["slug"]),
        "failures_by_criterion": {k: failures[k] for k in sorted(failures)},
    }
    return summary


def _count_by_type(tasks: list[dict]) -> dict:
    out: dict[str, dict[str, int]] = defaultdict(lambda: {"total": 0, "aligned": 0})
    for t in tasks:
        out[t["type"]]["total"] += 1
        out[t["type"]]["aligned"] += int(t["aligned"])
    return dict(out)


def write_findings(summary: dict, criteria: dict, path: Path) -> None:
    lines = ["# Implementation-rubric findings", ""]
    lines.append(
        f"{summary['aligned']}/{summary['total_tasks']} tasks aligned "
        f"(no blocker failed). Failures grouped by criterion, most severe first."
    )
    lines.append("")
    fbc = summary["failures_by_criterion"]
    for name in sorted(
        fbc, key=lambda n: (SEVERITY_ORDER.get(criteria[n].severity, 9), n)
    ):
        crit = criteria[name]
        items = fbc[name]
        lines.append(
            f"## {name}  ({crit.severity}, {crit.scope})  -  {len(items)} failing"
        )
        lines.append(f"_{crit.description}_")
        lines.append("")
        for it in sorted(items, key=lambda x: x["slug"]):
            expl = " ".join(it["explanation"].split())
            lines.append(f"- **{it['slug']}** ({it['type']}): {expl}")
        lines.append("")
    if not fbc:
        lines.append("No failures recorded.")
        lines.append("")
    path.write_text("\n".join(lines))


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--run-dir",
        metavar="DIR",
        help="run folder to aggregate (default: the latest run under rubric-results/)",
    )
    ap.add_argument(
        "--label-cap",
        type=float,
        default=DEFAULT_LABEL_CAP,
        help=f"max share of trivial-negative introspection answers (default: {DEFAULT_LABEL_CAP})",
    )
    args = ap.parse_args()

    run_dir = resolve_run_dir(args.run_dir)
    results = load_task_results(per_task_dir(run_dir))
    if not results:
        print(
            f"No per-task result files in {per_task_dir(run_dir)}. Run judge.py first.",
            file=sys.stderr,
        )
        return 1

    criteria = {c.name: c for c in load_criteria()}
    summary = aggregate(results, criteria, args.label_cap)
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    write_findings(summary, criteria, run_dir / "findings.md")

    s = summary
    print(
        f"Tasks: {s['total_tasks']}   Aligned: {s['aligned']}   Not aligned: {s['not_aligned']}"
    )
    for ttype, c in sorted(s["by_type"].items()):
        print(f"  {ttype}: {c['aligned']}/{c['total']} aligned")
    lm = s["label_metric"]
    if lm["classified"]:
        flag = "OK" if lm["within_cap"] else "OVER CAP"
        print(
            f"  non_guessable_answer: {lm['negatives']}/{lm['classified']} negatives "
            f"({lm['negative_share']:.0%}, cap {lm['cap']:.0%}) [{flag}]"
        )
    # Most-failing blocker/major criteria, for a quick read.
    ranked = sorted(
        ((n, v) for n, v in s["per_criterion"].items() if v["fail"]),
        key=lambda kv: (-kv[1]["fail"],),
    )[:10]
    if ranked:
        print("\nTop failing criteria:")
        for name, v in ranked:
            print(
                f"  {v['fail']:3} fail  {v['severity']:7} {name}  "
                f"(pass rate {v['pass_rate']:.0%} of {v['applicable']})"
                if v["pass_rate"] is not None
                else f"  {v['fail']:3} fail  {name}"
            )
    print(f"\nWrote {run_dir / 'summary.json'} and {run_dir / 'findings.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
