"""Pre-invoke for move-s3-contents-and-cleanup.

Resets the S3 data plane to its CDK baseline before the agent runs.

Best-effort: per-object failures are logged, not raised.
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

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")


def run(
    session: Optional[boto3.Session] = None, region: str = REGION, **parameters
) -> dict[str, str]:
    if session is None:
        session = boto3.Session(region_name=region)

    # Reset the S3 data plane to its baseline first, before anything else.
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
