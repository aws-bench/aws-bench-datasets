"""Post-invoke for analyze-b2b-commerce-summary-and-lifecycle.

Restores the B2B-commerce source bucket to its seed (empty, then re-put),
removing the agent's mutations. Best-effort; exit 0.
"""

import sys

from reset import reset_data_plane


def main() -> int:
    for err in reset_data_plane():
        print(err, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
