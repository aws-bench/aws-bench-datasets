"""Resolve {{placeholder}} tokens in /tests/ground_truth.json and, if present, in
every /tests/judge.toml [[criterion]].description, in place.

The framework injects placeholder values from [verifier.env] in task.toml as
env vars on the verifier container. This script substitutes {{name}} with the
corresponding env var and overwrites both files with the resolved version.

ground_truth.json is rewardkit's own [judge.files] input, so its placeholders
were always resolved here. judge.toml's criterion descriptions need the same
treatment: rewardkit (see judges.py) does no placeholder substitution of its
own, it only relays each criterion's description text verbatim into the judge
prompt -- so a per-claim rubric whose description embeds a raw {{name}} token
(as AWSBenchRubricGenerator's generated criteria do) would otherwise reach the
judge unresolved. Line-based rather than a full TOML re-serialize, to preserve
formatting/comments exactly and avoid a new TOML-writer dependency; safe
because only description lines ever contain {{...}} tokens.

Strict: exits non-zero if any {{name}} isn't set anywhere, surfacing missing
CFN exports loudly instead of silently leaking literal tokens to the judge.

Skipped per-file when that file doesn't exist (some tasks, e.g. programmatic
mutation verifiers, have neither; some rewardkit tasks still use the original
single-criterion judge.toml, which has no placeholders and is a no-op here).
"""

import os
import re
import sys
import json

GT = "/tests/ground_truth.json"
JUDGE_TOML = "/tests/judge.toml"

PLACEHOLDER_RE = re.compile(r"\{\{([^}]+)\}\}")
DESCRIPTION_LINE_RE = re.compile(r'^(description\s*=\s*)"((?:[^"\\]|\\.)*)"(\s*)$')


def _substitute(text: str, missing: list[str], escape=None) -> str:
    """Replace every {{name}} in text with its env var value.

    escape, when given, is applied to each replacement VALUE only (e.g. to
    keep a value with a literal quote/backslash from breaking TOML string
    syntax) -- never to the surrounding text, which may already contain its
    own (correctly escaped) literal quotes/backslashes that must pass through
    untouched.
    """

    def _replace(match: re.Match[str]) -> str:
        key = match.group(1)
        val = os.environ.get(key)
        if val is None:
            missing.append(key)
            return match.group(0)
        return escape(val) if escape else val

    return PLACEHOLDER_RE.sub(_replace, text)


def _toml_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _resolved_ground_truth(missing: list[str]) -> dict | None:
    """Return the resolved ground_truth dict, or None if the file doesn't exist."""
    if not os.path.exists(GT):
        return None
    with open(GT) as f:
        gt = json.load(f)
    return {k: _substitute(v, missing) if isinstance(v, str) else v for k, v in gt.items()}


def _resolved_judge_toml_lines(missing: list[str]) -> list[str] | None:
    """Return the resolved judge.toml lines, or None if the file doesn't exist
    or has no [[criterion]].description placeholders to resolve."""
    if not os.path.exists(JUDGE_TOML):
        return None

    with open(JUDGE_TOML) as f:
        lines = f.readlines()

    changed = False
    for i, line in enumerate(lines):
        has_newline = line.endswith("\n")
        stripped = line[:-1] if has_newline else line
        m = DESCRIPTION_LINE_RE.match(stripped)
        if not m or "{{" not in m.group(2):
            continue
        prefix, value, trailing = m.group(1), m.group(2), m.group(3)
        new_value = _substitute(value, missing, escape=_toml_escape)
        if new_value == value:
            continue
        lines[i] = f'{prefix}"{new_value}"{trailing}' + ("\n" if has_newline else "")
        changed = True

    return lines if changed else None


def main() -> int:
    # Two passes, matching over both files: compute every resolution first
    # (collecting all missing placeholders across ground_truth.json AND
    # judge.toml), and only write anything if nothing was missing anywhere --
    # a partial write on failure would leave one file resolved and the other
    # not, for no benefit, since a non-zero exit here aborts test.sh before
    # rewardkit ever runs either file.
    missing: list[str] = []
    resolved_gt = _resolved_ground_truth(missing)
    resolved_judge_lines = _resolved_judge_toml_lines(missing)

    if missing:
        print(
            f"Missing values for placeholders: {sorted(set(missing))}. "
            f"Declare them in [verifier.env] of task.toml so the framework "
            f"injects them as env vars.",
            file=sys.stderr,
        )
        return 1

    if resolved_gt is not None:
        tmp_path = GT + ".tmp"
        with open(tmp_path, "w") as f:
            json.dump(resolved_gt, f)
        os.replace(tmp_path, GT)

    if resolved_judge_lines is not None:
        tmp_path = JUDGE_TOML + ".tmp"
        with open(tmp_path, "w") as f:
            f.writelines(resolved_judge_lines)
        os.replace(tmp_path, JUDGE_TOML)

    return 0


if __name__ == "__main__":
    sys.exit(main())
