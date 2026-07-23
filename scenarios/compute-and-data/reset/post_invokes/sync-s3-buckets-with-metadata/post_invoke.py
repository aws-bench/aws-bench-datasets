"""Rollback for sync-s3-buckets-with-metadata.

Resets both S3 buckets to their CDK baseline: the source bucket holds only the
CDK-seeded sample.txt and the destination bucket is emptied.

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
