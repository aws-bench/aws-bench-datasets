"""Pre-invoke for manage-buckets-eks-sagemaker.

Uninstalls the agent-installed EKS add-ons and re-populates the seeded S3
baseline before each trial so both start from their baseline state.
"""

import json
import logging
import os
import sys
from typing import Optional

import boto3

from reset import reset_data_plane, uninstall_addons

logger = logging.getLogger(__name__)
RESULT_FILE = "/logs/pre_invoke/placeholder.json"

REGION = os.environ.get("AWS_REGION", "us-east-1")


def run(
    session: Optional[boto3.Session] = None, region: str = REGION, **parameters
) -> dict[str, str]:
    for err in uninstall_addons(session, region):
        logger.warning("uninstall_addons: %s", err)
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
