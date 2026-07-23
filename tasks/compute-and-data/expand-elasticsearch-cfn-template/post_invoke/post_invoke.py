"""Post-invoke for expand-elasticsearch-cfn-template.

Restores the seeded S3 template bucket to its baseline via the shared
reset_data_plane (also run in pre_invoke); this empties the versioned bucket,
so the agent-uploaded template is removed too.

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
