"""Post-invoke for cloudfront-with-lambda-edge.

Finds and deletes any CloudFront distributions with example.com as
origin along with associated Lambda@Edge functions and IAM roles.
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
