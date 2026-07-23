"""Pre-invoke: count unused EC2 security groups across the reachable regions.

"Unused" means a security group not attached to any Elastic Network Interface
(ENI). The scenario account is locked by a region-restrict SCP to its deploy
regions, so calls to any other region raise AccessDenied. We enumerate the
regions the account exposes and skip the ones the SCP denies, so the count
reflects exactly the regions a restricted agent can reach. Keeping this dynamic
means the ground truth tracks the deployed state and the allow-list instead of a
hardcoded number that silently rots.
"""

import json
import os
import sys

import boto3
from botocore.exceptions import ClientError

RESULT_FILE = "/logs/pre_invoke/placeholder.json"
COUNT_KEY = "4b68864e-UnusedSecurityGroupCount"

# Error codes the region-restrict SCP (or a disabled region) raises for a
# region we cannot reach; we skip those regions rather than fail.
_DENIED_CODES = {
    "AccessDenied",
    "AccessDeniedException",
    "UnauthorizedOperation",
    "AuthFailure",
}


def _enabled_regions(session):
    """Regions enabled for the account. describe-regions targets the us-east-1
    endpoint (an allowed region) and returns metadata for every enabled region,
    so it is not itself blocked by the SCP."""
    ec2 = session.client("ec2", region_name="us-east-1")
    resp = ec2.describe_regions(AllRegions=False)
    return [r["RegionName"] for r in resp["Regions"]]


def _unused_in_region(session, region):
    """Count SGs in `region` not attached to any ENI. Returns None if the
    region is denied (blocked by the SCP), so the caller can skip it."""
    ec2 = session.client("ec2", region_name=region)
    try:
        sg_ids = set()
        for page in ec2.get_paginator("describe_security_groups").paginate():
            for sg in page["SecurityGroups"]:
                sg_ids.add(sg["GroupId"])

        attached = set()
        for page in ec2.get_paginator("describe_network_interfaces").paginate():
            for eni in page["NetworkInterfaces"]:
                for grp in eni.get("Groups", []):
                    attached.add(grp["GroupId"])
    except ClientError as e:
        if e.response["Error"]["Code"] in _DENIED_CODES:
            return None
        raise
    return len(sg_ids - attached)


def run(session=None, region="us-east-1", **parameters):
    if not session:
        session = boto3.Session(region_name=region)

    total = 0
    for reg in _enabled_regions(session):
        count = _unused_in_region(session, reg)
        if count is not None:
            total += count
    return {COUNT_KEY: str(total)}


if __name__ == "__main__":
    try:
        placeholders = run()
    except Exception as e:
        print(f"pre_invoke failed: {e}", file=sys.stderr)
        sys.exit(1)

    # Write computed placeholder values to disk for the verifier to consume
    os.makedirs(os.path.dirname(RESULT_FILE), exist_ok=True)
    with open(RESULT_FILE, "w") as f:
        json.dump(placeholders, f, indent=2)
