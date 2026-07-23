"""Post-invoke for ipam-create-verification-tokens.

Deletes any verification tokens left on the seeded IPAM so the agent starts
against a clean IPAM (zero tokens).
"""

import sys

from reset import reset_control_plane


def main() -> int:
    errors = reset_control_plane()
    for err in errors:
        print(err, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
