"""Pre-invoke for expand-elasticsearch-cfn-template.

Resets the seeded S3 template bucket to its baseline before each trial.

Best-effort; exit 0.
"""

import json
import os
import sys

from reset import reset_data_plane

RESULT_FILE = "/logs/pre_invoke/placeholder.json"


def main() -> int:
    for err in reset_data_plane():
        print(err, file=sys.stderr)
    os.makedirs(os.path.dirname(RESULT_FILE), exist_ok=True)
    with open(RESULT_FILE, "w") as f:
        json.dump({}, f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
