"""Extend [verifier.env] for tasks whose ground_truth.json references
placeholders not currently declared in task.toml.

The strict resolve_placeholders.py exits non-zero if any {{name}} token in
ground_truth.json has no env var. This script audits every task and, for
those with undeclared tokens, appends `name = "{{name}}"` lines to the
[verifier.env] block so the framework injects them at run time.

Usage:
    python3 shared/judge/scripts/fix_verifier_env.py             # dry run
    python3 shared/judge/scripts/fix_verifier_env.py --apply     # write
"""

import argparse
import re
import sys
import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
TASKS_DIR = REPO_ROOT / "tasks"


def placeholders_in(gt_path: Path) -> set[str]:
    return set(re.findall(r"\{\{([^}]+)\}\}", gt_path.read_text()))


def declared_env(task_toml: Path) -> set[str]:
    with task_toml.open("rb") as f:
        cfg = tomllib.load(f)
    return set((cfg.get("verifier", {}) or {}).get("env", {}).keys())


def append_to_verifier_env(task_toml: Path, missing: list[str]) -> None:
    """Append `key = "{{key}}"` lines to the [verifier.env] block.

    If [verifier.env] already exists, insert new keys at the end of that
    block (before the next blank line or section header).

    If [verifier.env] doesn't exist, create a fresh block immediately after
    the [verifier] block ends. The block ends at the first subsequent
    section header `[...]`; we walk backwards past blank lines and TOML
    comment lines (`#`) so the new block lands directly after the last
    real key in [verifier], preserving the comment/blank separator that
    precedes the next section.
    """
    text = task_toml.read_text()
    lines = text.splitlines(keepends=True)

    new_entries = [f'{k} = "{{{{{k}}}}}"\n' for k in missing]

    env_idx = next(
        (i for i, ln in enumerate(lines) if ln.strip() == "[verifier.env]"),
        None,
    )
    if env_idx is not None:
        insert_idx = len(lines)
        for i in range(env_idx + 1, len(lines)):
            if lines[i].strip() == "" or lines[i].lstrip().startswith("["):
                insert_idx = i
                break
        lines[insert_idx:insert_idx] = new_entries
        task_toml.write_text("".join(lines))
        return

    verifier_idx = next(
        (i for i, ln in enumerate(lines) if ln.strip() == "[verifier]"),
        None,
    )
    if verifier_idx is None:
        raise RuntimeError(f"{task_toml}: no [verifier] or [verifier.env] block found")

    next_section_idx = len(lines)
    for i in range(verifier_idx + 1, len(lines)):
        if lines[i].lstrip().startswith("["):
            next_section_idx = i
            break

    insert_idx = next_section_idx
    while insert_idx > verifier_idx + 1:
        prev = lines[insert_idx - 1]
        if prev.strip() == "" or prev.lstrip().startswith("#"):
            insert_idx -= 1
        else:
            break

    block = ["\n", "[verifier.env]\n", *new_entries]
    lines[insert_idx:insert_idx] = block
    task_toml.write_text("".join(lines))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply", action="store_true", help="Write changes (default: dry run)"
    )
    args = parser.parse_args()

    fixes: list[tuple[Path, list[str]]] = []
    for gt in sorted(TASKS_DIR.glob("*/*/tests/ground_truth.json")):
        task_dir = gt.parent.parent
        task_toml = task_dir / "task.toml"
        if not task_toml.exists():
            continue
        missing = placeholders_in(gt) - declared_env(task_toml)
        if missing:
            fixes.append((task_toml, sorted(missing)))

    if not fixes:
        print("No tasks need fixing.")
        return 0

    print(f"Found {len(fixes)} task(s) with undeclared placeholders:")
    for task_toml, missing in fixes:
        rel = task_toml.relative_to(REPO_ROOT)
        print(f"  {rel}")
        for k in missing:
            print(f"    + {k}")

    if not args.apply:
        print()
        print(
            f"Dry run. Re-run with --apply to write changes to {len(fixes)} task.toml file(s)."
        )
        return 0

    for task_toml, missing in fixes:
        append_to_verifier_env(task_toml, missing)
    print()
    print(f"Updated {len(fixes)} task.toml file(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
