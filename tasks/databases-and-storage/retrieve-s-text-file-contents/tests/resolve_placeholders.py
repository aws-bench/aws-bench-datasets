"""Resolve {{placeholder}} tokens in /tests/ground_truth.json in place.

The framework injects placeholder values from [verifier.env] in task.toml as
env vars on the verifier container. This script reads ground_truth.json,
substitutes {{name}} with the corresponding env var, and overwrites the file
with the resolved version -- which rewardkit's judge.toml references as one
of its [judge.files].

Strict: exits non-zero if any {{name}} isn't set, surfacing missing CFN
exports loudly instead of silently leaking literal tokens to the judge.

Skipped when /tests/ground_truth.json doesn't exist (some tasks, e.g.
programmatic mutation verifiers, don't need it).
"""

import json
import os
import re
import sys

GT = "/tests/ground_truth.json"


def main() -> int:
    if not os.path.exists(GT):
        return 0

    with open(GT) as f:
        gt = json.load(f)

    missing: list[str] = []

    def sub(s: str) -> str:
        def _replace(match: re.Match[str]) -> str:
            key = match.group(1)
            val = os.environ.get(key)
            if val is None:
                missing.append(key)
                return match.group(0)
            return val

        return re.sub(r"\{\{([^}]+)\}\}", _replace, s)

    resolved = {k: sub(v) if isinstance(v, str) else v for k, v in gt.items()}

    if missing:
        print(
            f"Missing values for placeholders: {sorted(set(missing))}. "
            f"Declare them in [verifier.env] of task.toml so the framework "
            f"injects them as env vars.",
            file=sys.stderr,
        )
        return 1

    # Atomic write: a partial write here would leave the ground_truth corrupt
    # for the judge (and unrecoverable, since we no longer have the source).
    tmp_path = GT + ".tmp"
    with open(tmp_path, "w") as f:
        json.dump(resolved, f)
    os.replace(tmp_path, GT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
