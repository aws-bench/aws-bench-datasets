#!/bin/bash
set -euo pipefail

OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

RESULT=$(python3 - <<'PY'
import boto3
from botocore.exceptions import ClientError

DENIED = {"AccessDenied", "AccessDeniedException", "UnauthorizedOperation", "AuthFailure"}
session = boto3.Session(region_name="us-east-1")

def unused_in_region(region):
    ec2 = session.client("ec2", region_name=region)
    try:
        groups = {}
        for page in ec2.get_paginator("describe_security_groups").paginate():
            for sg in page["SecurityGroups"]:
                groups[sg["GroupId"]] = sg["GroupName"]
        attached = set()
        for page in ec2.get_paginator("describe_network_interfaces").paginate():
            for eni in page["NetworkInterfaces"]:
                for grp in eni.get("Groups", []):
                    attached.add(grp["GroupId"])
    except ClientError as e:
        if e.response["Error"]["Code"] in DENIED:
            return None
        raise
    return {gid: name for gid, name in groups.items() if gid not in attached}

regions = [r["RegionName"] for r in
           session.client("ec2", region_name="us-east-1").describe_regions(AllRegions=False)["Regions"]]

total = 0
default_count = 0
us_east_1_non_default = None
for reg in regions:
    unused = unused_in_region(reg)
    if unused is None:
        continue
    total += len(unused)
    default_count += sum(1 for name in unused.values() if name == "default")
    if reg == "us-east-1":
        non_default = sorted(gid for gid, name in unused.items() if name != "default")
        if non_default:
            us_east_1_non_default = non_default[0]

print(total)
print(default_count)
print(us_east_1_non_default)
PY
)

COUNT=$(printf '%s\n' "$RESULT" | sed -n '1p')
DEFAULTS=$(printf '%s\n' "$RESULT" | sed -n '2p')
US_EAST_1_UNUSED_SG=$(printf '%s\n' "$RESULT" | sed -n '3p')

cat > "$OUT" <<EOF
You have ${COUNT} unused security groups across the reachable regions (security groups not attached to any elastic network interface). ${DEFAULTS} of the ${COUNT} are default security groups that AWS automatically creates for each VPC, so most of them are defaults. In us-east-1, one of the unused security groups is ${US_EAST_1_UNUSED_SG}.
EOF
