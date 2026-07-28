#!/bin/bash
set -euo pipefail

OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

REGIONS="us-east-1 us-west-1 us-west-2"

REGIONS="$REGIONS" python3 - > "$OUT" <<'PY'
import os
import boto3

regions = os.environ["REGIONS"].split()
per_region = {}
for region in regions:
    ec2 = boto3.client("ec2", region_name=region)
    rts = ec2.describe_route_tables()["RouteTables"]
    public_subnets = set()
    main_public = {}
    explicit = set()
    for rt in rts:
        vpc = rt["VpcId"]
        is_public = any(
            r.get("DestinationCidrBlock") == "0.0.0.0/0"
            and str(r.get("GatewayId", "")).startswith("igw-")
            for r in rt.get("Routes", [])
        )
        for assoc in rt.get("Associations", []):
            if assoc.get("Main"):
                main_public[vpc] = is_public
            elif assoc.get("SubnetId"):
                explicit.add(assoc["SubnetId"])
                if is_public:
                    public_subnets.add(assoc["SubnetId"])
    for sn in ec2.describe_subnets()["Subnets"]:
        sid = sn["SubnetId"]
        if sid not in explicit and main_public.get(sn["VpcId"]):
            public_subnets.add(sid)

    reservations = ec2.describe_instances(
        Filters=[{"Name": "instance-state-name",
                  "Values": ["pending", "running", "stopping", "stopped"]}]
    )["Reservations"]
    found = sorted(
        inst["InstanceId"]
        for res in reservations
        for inst in res["Instances"]
        if inst.get("SubnetId") in public_subnets
    )
    per_region[region] = found

lines = ["Here are your EC2 instances that are in a public subnet:", ""]
for region in regions:
    found = per_region[region]
    if found:
        lines.append(f"In {region}: {', '.join(found)}.")
    else:
        lines.append(f"In {region}: no EC2 instances are in a public subnet.")
print("\n".join(lines))
PY
