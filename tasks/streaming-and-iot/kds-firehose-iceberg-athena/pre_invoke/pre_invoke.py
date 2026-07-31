import os
import logging
import json
import sys

from reset import reset_data_plane

logger = logging.getLogger(__name__)
RESULT_FILE = "/logs/pre_invoke/placeholder.json"
REGION = os.environ.get("AWS_REGION", "us-east-1")


def run():
    logger.info("running pre-invoke logic")
    reset_data_plane(region=REGION)
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
