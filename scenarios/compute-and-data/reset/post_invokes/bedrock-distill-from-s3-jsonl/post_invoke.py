"""Rollback for bedrock-distill-from-s3-jsonl.

Resets the seeded S3 training data to baseline.

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
