"""Pre-invoke for troubleshoot-asg-ssh-connectivity.

Scales the target Auto Scaling Group up to 1 instance so the agent can
inspect a live instance (subnet routing, security group, NACL, key pair).
The stack deploys at DesiredCapacity=0 so the POST_SETUP baseline is stable.

Env vars (from ``[pre_invoke.env]`` in task.toml):
    ASG_NAME    Target Auto Scaling Group name.
    AWS_REGION  Region the ASG lives in.
"""

import json
import logging
import os
import sys
import time

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

DESIRED_CAPACITY = 1
SCALE_TIMEOUT_SEC = 480
POLL_INTERVAL_SEC = 10

RESULT_FILE = "/logs/pre_invoke/placeholder.json"


def run() -> None:
    name = os.environ["ASG_NAME"]
    region = os.environ["AWS_REGION"]
    asg = boto3.client("autoscaling", region_name=region)

    group = asg.describe_auto_scaling_groups(AutoScalingGroupNames=[name])[
        "AutoScalingGroups"
    ][0]
    new_max = max(group.get("MaxSize", 0), DESIRED_CAPACITY)

    asg.update_auto_scaling_group(
        AutoScalingGroupName=name,
        MinSize=DESIRED_CAPACITY,
        MaxSize=new_max,
        DesiredCapacity=DESIRED_CAPACITY,
    )
    logger.info(f"Scaled {name} to Desired={DESIRED_CAPACITY} (Max={new_max})")

    deadline = time.monotonic() + SCALE_TIMEOUT_SEC
    while time.monotonic() < deadline:
        group = asg.describe_auto_scaling_groups(AutoScalingGroupNames=[name])[
            "AutoScalingGroups"
        ][0]
        live = [
            i
            for i in group.get("Instances", [])
            if i.get("LifecycleState") in ("Pending", "InService")
        ]
        if len(live) >= DESIRED_CAPACITY:
            logger.info(f"{name}: {len(live)} live instance(s)")
            return
        time.sleep(POLL_INTERVAL_SEC)
    raise TimeoutError(
        f"{name} did not reach {DESIRED_CAPACITY} live instance(s) in {SCALE_TIMEOUT_SEC}s"
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    try:
        run()
    except (ClientError, KeyError, TimeoutError) as e:
        print(f"pre_invoke failed: {e}", file=sys.stderr)
        sys.exit(1)
    os.makedirs(os.path.dirname(RESULT_FILE), exist_ok=True)
    with open(RESULT_FILE, "w") as f:
        json.dump({}, f)
