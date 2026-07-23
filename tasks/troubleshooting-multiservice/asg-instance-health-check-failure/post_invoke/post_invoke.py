"""Post-invoke for asg-instance-health-check-failure.

Scales the ASG back to 0 and waits for all instances to actually
terminate (both from the ASG's view and from EC2's), so ``env verify``
sees the same baseline the setup snapshot captured.

Env vars (from ``[post_invoke.env]`` in task.toml):
    ASG_NAME    Target Auto Scaling Group name.
    AWS_REGION  Region the ASG lives in.
"""

import logging
import os
import sys
import time

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

SCALE_TIMEOUT_SEC = 480
POLL_INTERVAL_SEC = 10

# Instance states that would still show up in a describe_instances scan
# and therefore count as "not yet terminated" for verify purposes.
NON_TERMINATED_STATES = ("pending", "running", "stopping", "stopped", "shutting-down")


def run() -> None:
    name = os.environ["ASG_NAME"]
    region = os.environ["AWS_REGION"]
    asg = boto3.client("autoscaling", region_name=region)
    ec2 = boto3.client("ec2", region_name=region)

    try:
        asg.update_auto_scaling_group(
            AutoScalingGroupName=name, MinSize=0, DesiredCapacity=0
        )
    except ClientError as e:
        if e.response.get("Error", {}).get(
            "Code"
        ) == "ValidationError" and "not found" in str(e):
            # Stack was already torn down; nothing to do.
            return
        raise
    logger.info(f"Scaled {name} to Desired=0")

    # Wait until BOTH the ASG has no instances and EC2 has no instances
    # tagged with this ASG in a non-terminated state. ASG.Instances clears
    # as soon as terminate is issued, but EC2 keeps them visible in
    # "shutting-down" for 30-60s afterwards; env-verify would flag them.
    deadline = time.monotonic() + SCALE_TIMEOUT_SEC
    while time.monotonic() < deadline:
        asg_instances = asg.describe_auto_scaling_groups(AutoScalingGroupNames=[name])[
            "AutoScalingGroups"
        ][0].get("Instances", [])
        ec2_live = ec2.describe_instances(
            Filters=[
                {"Name": "tag:aws:autoscaling:groupName", "Values": [name]},
                {"Name": "instance-state-name", "Values": list(NON_TERMINATED_STATES)},
            ]
        )["Reservations"]
        live_ids = [i["InstanceId"] for r in ec2_live for i in r.get("Instances", [])]
        if not asg_instances and not live_ids:
            logger.info(f"{name}: terminated cleanly")
            return
        time.sleep(POLL_INTERVAL_SEC)
    raise TimeoutError(
        f"{name} did not terminate all instances in {SCALE_TIMEOUT_SEC}s "
        f"(ASG.Instances={len(asg_instances)}, EC2 live={live_ids})"
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    try:
        run()
    except (ClientError, KeyError, TimeoutError) as e:
        print(f"post_invoke failed: {e}", file=sys.stderr)
        sys.exit(1)
