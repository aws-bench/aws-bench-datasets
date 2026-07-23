"""Pre-invoke for create-emr-cluster-multi-master.

Terminates any existing EMR clusters in ap-southeast-1 so the agent
starts from a clean slate.
"""

import json
import os
import sys

from reset import reset_data_plane

RESULT_FILE = "/logs/pre_invoke/placeholder.json"


def main() -> int:
    errors = reset_data_plane()
    for err in errors:
        print(err, file=sys.stderr)

    os.makedirs(os.path.dirname(RESULT_FILE), exist_ok=True)
    with open(RESULT_FILE, "w") as f:
        json.dump({}, f)

    return 0


if __name__ == "__main__":
    sys.exit(main())
