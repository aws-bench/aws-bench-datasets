"""Rollback for manage-buckets-eks-sagemaker.

Uninstalls the agent-installed EKS add-ons and restores the seeded S3 baseline.

Best-effort; exit 0.
"""

import sys

from reset import reset_data_plane, uninstall_addons


def main() -> int:
    errors = uninstall_addons()
    errors.extend(reset_data_plane())
    for err in errors:
        print(err, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
