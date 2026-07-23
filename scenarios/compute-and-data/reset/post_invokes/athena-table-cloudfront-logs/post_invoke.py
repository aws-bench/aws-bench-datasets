"""Post-invoke for athena-table-cloudfront-logs.

Removes any Athena/Glue databases and tables that reference the
CloudFront log bucket so subsequent trials start from a clean slate.
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
