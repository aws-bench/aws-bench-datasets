"""Post-invoke for create-emr-cluster-multi-master.

Terminates any existing EMR clusters in ap-southeast-1 so subsequent
trials start from a clean slate.
"""

import sys

from reset import reset_data_plane


def main() -> int:
    errors = reset_data_plane()
    for err in errors:
        print(err, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
