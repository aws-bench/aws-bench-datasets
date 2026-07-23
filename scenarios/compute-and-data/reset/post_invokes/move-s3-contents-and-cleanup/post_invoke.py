"""Rollback for move-s3-contents-and-cleanup.

Restores the seeded S3 bucket to its CDK baseline.

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
