"""Post-invoke for dynamodb-strip-ec2-fields-from-prod.

Wipes and re-seeds the DynamoDB table to the CDK baseline so
subsequent trials start with the ec2 fields present on the target records.
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
