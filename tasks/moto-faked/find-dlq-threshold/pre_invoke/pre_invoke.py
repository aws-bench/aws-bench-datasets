"""Pre-invoke for find-dlq-threshold (introspection, read-only).

No data-plane seeding: the queue and its redrive policy are described as
deployed, and every {{placeholder}} in the instruction resolves from
scenario CloudFormation exports at verify time. Writes the placeholder map
(empty) so the pre_invoke/logs contract holds.
"""

import json
import os

RESULT_FILE = "/logs/pre_invoke/placeholder.json"


def run() -> None:
    os.makedirs(os.path.dirname(RESULT_FILE), exist_ok=True)
    with open(RESULT_FILE, "w") as f:
        json.dump({}, f)


if __name__ == "__main__":
    run()
