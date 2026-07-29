"""Rollback for neptune-bulk-load-and-shortest-path.

Resets the graph to the empty baseline and reseeds the S3 loader bucket.
Best-effort: errors print to stderr; exit 0.
"""

import os
import sys

from reset import reset_data_plane

REGION = os.environ.get("AWS_REGION", "us-east-1")


def main() -> int:
    for err in reset_data_plane(region=REGION):
        print(err, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
