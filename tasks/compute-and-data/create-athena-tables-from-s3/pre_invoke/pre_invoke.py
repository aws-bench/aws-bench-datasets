"""Pre-invoke for create-athena-tables-from-s3.

Resets the task's S3 seed data to baseline before the trial.

Best-effort: reset errors are logged as warnings, never raised.
"""

import json
import logging
import os
import sys
from typing import Optional

import boto3

from reset import reset_data_plane

logger = logging.getLogger(__name__)
RESULT_FILE = "/logs/pre_invoke/placeholder.json"

REGION = os.environ.get("AWS_REGION", "us-east-1")


def run(
    session: Optional[boto3.Session] = None, region: str = REGION, **parameters
) -> dict[str, str]:
    if session is None:
        session = boto3.Session(region_name=region)

    # Re-establish the S3 data plane to its seeded baseline first, so the
    # trial starts from the same state regardless of prior mutations.
    for err in reset_data_plane(session, region):
        logger.warning("reset_data_plane: %s", err)

    return {}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    try:
        placeholders = run()
    except Exception as e:
        print(f"pre_invoke failed: {e}", file=sys.stderr)
        sys.exit(1)
    os.makedirs(os.path.dirname(RESULT_FILE), exist_ok=True)
    with open(RESULT_FILE, "w") as f:
        json.dump(placeholders, f)
