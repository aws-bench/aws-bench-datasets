"""Rollback for connect-create-customer-profiles.

Deletes the agent-created profiles for the two target account numbers so
the next trial starts from the empty baseline domain. Delegates to the
shared, idempotent reset.

Best-effort; exit 0.
"""

import sys

from reset import reset_data_plane


def main() -> int:
    for err in reset_data_plane():
        print(err, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
