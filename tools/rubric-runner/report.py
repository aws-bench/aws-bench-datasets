#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Render the aggregated rubric results into a self-contained, sortable HTML grid.

Reads summary.json (from aggregate.py) and the per-task result files, and writes
report.html: one row per task, one column per criterion, a pass/fail/n-a pill in each
cell with the judge's explanation on hover, plus an alignment column and filters. The
page is a single file with no external assets, so it can be opened or attached directly.

Only the dependency-free HTML viewer shell (styling, client-side sort/filter, hover
tooltips) is borrowed from Terminal Bench 3's tools/batch-grader/concatenate_results.py;
none of that tool's proposal-grading logic is used. aws-bench does not do proposal grading
(the batch-grader path grades a task idea's instruction.md against a coarse accept/reject
decision before the task is built; our tasks already exist). The viewer here was retargeted
to our structured pass/fail/not_applicable verdicts and the per-task alignment result, and
reads the aggregator's JSON directly rather than parsing prose.

Usage:
    uv run tools/rubric-runner/report.py                  # the latest run
    uv run tools/rubric-runner/report.py --run-dir DIR --open
"""

from __future__ import annotations

import argparse
import json
import sys
import webbrowser
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


def build_rows(tasks_dir: Path, summary: dict) -> tuple[list[dict], list[dict]]:
    """Return (column-defs, row-records) for the grid."""
    criteria = load_criteria()
    # Column order: alignment, then criteria by severity then name.
    ordered = sorted(criteria, key=lambda c: (SEVERITY_ORDER[c.severity], c.name))
    columns = [
        {
            "name": c.name,
            "severity": c.severity,
            "scope": c.scope,
            "description": c.description,
        }
        for c in ordered
    ]

    # Map slug -> per-task raw checks (the per-task/ subfolder holds only <slug>.json).
    raw = {d["slug"]: d for d in load_task_results(tasks_dir)}

    aligned_by_slug = {t["slug"]: t["aligned"] for t in summary["tasks"]}
    rows = []
    for slug, d in sorted(raw.items()):
        cells = {}
        for name, check in d["checks"].items():
            cells[name] = {
                "outcome": outcome_str(check.get("outcome")),
                "explanation": check.get("explanation", ""),
            }
        rows.append(
            {
                "slug": slug,
                "type": d["type"],
                "aligned": aligned_by_slug.get(slug, True),
                "cells": cells,
            }
        )
    return columns, rows


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--run-dir",
        metavar="DIR",
        help="run folder holding summary.json (default: the latest run under rubric-results/)",
    )
    ap.add_argument(
        "--open", action="store_true", help="open the report in a browser when done"
    )
    args = ap.parse_args()

    run_dir = resolve_run_dir(args.run_dir)
    summary_path = run_dir / "summary.json"
    if not summary_path.is_file():
        print(f"No summary.json in {run_dir}. Run aggregate.py first.", file=sys.stderr)
        return 1
    summary = json.loads(summary_path.read_text())
    columns, rows = build_rows(per_task_dir(run_dir), summary)

    html = (
        HTML_TEMPLATE.replace("__COLUMNS__", json.dumps(columns))
        .replace("__ROWS__", json.dumps(rows))
        .replace("__SUMMARY__", json.dumps(summary_meta(summary)))
    )
    out = run_dir / "report.html"
    out.write_text(html)
    print(f"Wrote {out}  ({len(rows)} tasks, {len(columns)} criteria)")
    if args.open:
        webbrowser.open(out.resolve().as_uri())
    return 0


def summary_meta(summary: dict) -> dict:
    lm = summary["label_metric"]
    return {
        "total": summary["total_tasks"],
        "aligned": summary["aligned"],
        "not_aligned": summary["not_aligned"],
        "by_type": summary["by_type"],
        "label": lm,
        "per_criterion": summary["per_criterion"],
    }


HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aws-bench Implementation Rubric Report</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
h1 { color: #f0f6fc; margin-bottom: 8px; font-size: 22px; }
.subtitle { color: #8b949e; margin-bottom: 20px; font-size: 14px; }
.summary { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
.card { padding: 10px 18px; border-radius: 8px; background: #161b22; border: 1px solid #30363d; }
.card .count { font-size: 26px; font-weight: 700; color: #f0f6fc; }
.card .label { font-size: 12px; color: #8b949e; }
.controls { margin-bottom: 14px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.controls input, .controls select { padding: 7px 11px; border-radius: 6px; border: 1px solid #30363d; background: #161b22; color: #c9d1d9; font-size: 13px; }
.controls input { width: 260px; }
.controls label { font-size: 13px; color: #8b949e; display: flex; gap: 6px; align-items: center; }
.tablewrap { overflow-x: auto; border: 1px solid #21262d; border-radius: 8px; }
table { border-collapse: collapse; font-size: 13px; }
th { position: sticky; top: 0; background: #161b22; padding: 8px 8px; text-align: left; cursor: pointer; user-select: none; border-bottom: 2px solid #30363d; color: #8b949e; white-space: nowrap; z-index: 2; }
th:hover { color: #f0f6fc; }
th.sev-blocker { color: #ff7b72; } th.sev-major { color: #d29922; } th.sev-minor { color: #8b949e; } th.sev-label { color: #58a6ff; }
td { padding: 5px 8px; border-bottom: 1px solid #21262d; white-space: nowrap; }
tr:hover { background: #1c2128; }
td.task { font-weight: 600; color: #58a6ff; position: sticky; left: 0; background: #0d1117; z-index: 1; }
tr:hover td.task { background: #1c2128; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; position: relative; cursor: default; }
.o-pass { background: #0d3620; color: #56d364; }
.o-fail { background: #5a0f0f; color: #ff7b72; }
.o-not_applicable { background: #21262d; color: #8b949e; }
.o-missing { background: transparent; color: #30363d; }
.aligned-yes { background: #0d4429; color: #3fb950; }
.aligned-no { background: #5a0f0f; color: #ff7b72; }
.tooltip { display: none; position: absolute; z-index: 100; left: 0; top: calc(100% + 6px); background: #1c2128; border: 1px solid #30363d; border-radius: 8px; padding: 10px; width: 360px; white-space: normal; font-size: 12px; font-weight: 400; line-height: 1.5; color: #c9d1d9; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
/* The rightmost columns sit near the right edge of a wide table, so a left-anchored 360px
   tooltip would overflow off-screen and be unreadable. Anchor those to the right instead,
   so they open leftward and stay on screen. */
td:nth-last-child(-n+6) .tooltip, th:nth-last-child(-n+6) .tooltip { left: auto; right: 0; }
.pill:hover .tooltip { display: block; }
/* Header tooltip: shows what each criterion checks. pointer-events:none keeps it from
   intercepting the click that sorts the column, and normal-weight non-sticky text keeps
   it readable over the sticky header. */
.th-tip { pointer-events: none; font-weight: 400; text-transform: none; }
th:hover .th-tip { display: block; }
.type-tag { font-size: 11px; color: #8b949e; }
</style>
</head>
<body>
<h1>aws-bench Implementation Rubric Report</h1>
<div class="subtitle" id="subtitle"></div>
<div class="summary" id="summary"></div>
<div class="controls">
  <input type="text" id="search" placeholder="Filter tasks...">
  <select id="typeFilter"><option value="">all types</option><option value="introspection">introspection</option><option value="mutation">mutation</option></select>
  <label><input type="checkbox" id="onlyFailing"> only not-aligned</label>
  <label><input type="checkbox" id="onlyWithFails"> only rows with a fail</label>
</div>
<div class="tablewrap">
<table id="table"><thead><tr id="thead-row"></tr></thead><tbody id="tbody"></tbody></table>
</div>
<script>
const COLUMNS = __COLUMNS__;
const ROWS = __ROWS__;
const SUMMARY = __SUMMARY__;
const OUTCOME_RANK = { fail: 0, pass: 1, not_applicable: 2, missing: 3 };

let sortCol = "aligned";
let sortDir = 1;

function renderSummary() {
  const s = SUMMARY;
  document.getElementById("subtitle").textContent =
    `${s.total} tasks judged. Aligned = no blocker failed.`;
  const el = document.getElementById("summary");
  const cards = [
    { count: s.aligned, label: "aligned" },
    { count: s.not_aligned, label: "not aligned" },
  ];
  for (const [t, c] of Object.entries(s.by_type)) cards.push({ count: `${c.aligned}/${c.total}`, label: `${t} aligned` });
  if (s.label && s.label.classified) {
    const pct = Math.round((s.label.negative_share || 0) * 100);
    const cap = Math.round((s.label.cap || 0) * 100);
    cards.push({ count: `${pct}%`, label: `non-guessable negatives (cap ${cap}%)${s.label.within_cap ? "" : " OVER"}` });
  }
  el.innerHTML = cards.map(c => `<div class="card"><div class="count">${c.count}</div><div class="label">${c.label}</div></div>`).join("");
}

function cellOutcome(row, colName) {
  const c = row.cells[colName];
  return c ? c.outcome : "missing";
}

function sortVal(row, col) {
  if (col === "slug") return row.slug.toLowerCase();
  if (col === "aligned") return row.aligned ? 1 : 0;
  return OUTCOME_RANK[cellOutcome(row, col)] ?? 3;
}

function render() {
  renderSummary();
  const q = document.getElementById("search").value.toLowerCase();
  const typeF = document.getElementById("typeFilter").value;
  const onlyFailing = document.getElementById("onlyFailing").checked;
  const onlyWithFails = document.getElementById("onlyWithFails").checked;

  let rows = ROWS.filter(r => {
    if (q && !r.slug.toLowerCase().includes(q)) return false;
    if (typeF && r.type !== typeF) return false;
    if (onlyFailing && r.aligned) return false;
    if (onlyWithFails && !Object.values(r.cells).some(c => c.outcome === "fail")) return false;
    return true;
  });
  rows.sort((a, b) => {
    const va = sortVal(a, sortCol), vb = sortVal(b, sortCol);
    if (va < vb) return -sortDir;
    if (va > vb) return sortDir;
    return a.slug.localeCompare(b.slug);
  });

  const thead = document.getElementById("thead-row");
  const cols = [{ name: "slug", label: "Task", severity: "" }, { name: "aligned", label: "Aligned", severity: "" }, ...COLUMNS.map(c => ({ name: c.name, label: c.name, severity: c.severity, scope: c.scope, description: c.description }))];
  thead.innerHTML = "";
  cols.forEach(col => {
    const th = document.createElement("th");
    if (col.severity) th.className = "sev-" + col.severity;
    const arrow = sortCol === col.name ? (sortDir === 1 ? " ▲" : " ▼") : "";
    // Label as a span so the description tooltip can sit beside it without being
    // clipped by the cell text. The tooltip has pointer-events:none, so hovering it
    // never steals the click: sorting on the header still fires.
    const labelSpan = document.createElement("span");
    labelSpan.textContent = col.label + arrow;
    th.appendChild(labelSpan);
    if (col.description) {
      const tip = document.createElement("div");
      tip.className = "tooltip th-tip";
      tip.textContent = `${col.name} [${col.severity}, ${col.scope}]: ${col.description}`;
      th.appendChild(tip);
    } else {
      th.title = col.name;
    }
    th.onclick = () => { if (sortCol === col.name) sortDir *= -1; else { sortCol = col.name; sortDir = 1; } render(); };
    thead.appendChild(th);
  });

  const tbody = document.getElementById("tbody");
  tbody.innerHTML = "";
  rows.forEach(row => {
    const tr = document.createElement("tr");
    const tdTask = document.createElement("td");
    tdTask.className = "task";
    tdTask.innerHTML = `${row.slug}<br><span class="type-tag">${row.type}</span>`;
    tr.appendChild(tdTask);

    const tdAl = document.createElement("td");
    const al = document.createElement("span");
    al.className = "pill " + (row.aligned ? "aligned-yes" : "aligned-no");
    al.textContent = row.aligned ? "yes" : "no";
    tdAl.appendChild(al);
    tr.appendChild(tdAl);

    COLUMNS.forEach(col => {
      const td = document.createElement("td");
      const cell = row.cells[col.name];
      const outcome = cell ? cell.outcome : "missing";
      const pill = document.createElement("span");
      pill.className = "pill o-" + outcome;
      pill.textContent = { pass: "pass", fail: "FAIL", not_applicable: "n/a", missing: "·" }[outcome] || outcome;
      if (cell && cell.explanation) {
        const tip = document.createElement("div");
        tip.className = "tooltip";
        tip.textContent = `${col.name} [${col.severity}]: ${cell.explanation}`;
        pill.appendChild(tip);
      }
      td.appendChild(pill);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

["search", "typeFilter", "onlyFailing", "onlyWithFails"].forEach(id => {
  document.getElementById(id).addEventListener("input", render);
});
render();
</script>
</body>
</html>
"""

if __name__ == "__main__":
    raise SystemExit(main())
