"""Post-invoke for deploy-ec2-instance-with-ebs.

Detaches the EBS volume from any instance and terminates that instance
so subsequent trials start with the volume in 'available' state.
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
