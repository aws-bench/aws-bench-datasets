"""Pre-invoke: compute total hourly on-demand cost of all running
EC2 instances in us-east-1, broken down by instance type and OS."""

import json
import os
import sys
from collections import Counter

import boto3

RESULT_FILE = "/logs/pre_invoke/placeholder.json"

# AWS Pricing API location string for us-east-1
LOCATION = "US East (N. Virginia)"


def _get_hourly_price(pricing, instance_type: str, os_name: str) -> float:
    """Look up the on-demand hourly price for a given instance type and OS
    using the AWS Pricing API with filters for shared tenancy, no pre-installed
    software, and no license required."""
    resp = pricing.get_products(
        ServiceCode="AmazonEC2",
        Filters=[
            {"Type": "TERM_MATCH", "Field": "instanceType", "Value": instance_type},
            {"Type": "TERM_MATCH", "Field": "location", "Value": LOCATION},
            {"Type": "TERM_MATCH", "Field": "operatingSystem", "Value": os_name},
            {"Type": "TERM_MATCH", "Field": "tenancy", "Value": "Shared"},
            {"Type": "TERM_MATCH", "Field": "preInstalledSw", "Value": "NA"},
            {"Type": "TERM_MATCH", "Field": "capacitystatus", "Value": "Used"},
            {
                "Type": "TERM_MATCH",
                "Field": "licenseModel",
                "Value": "No License required",
            },
        ],
        MaxResults=1,
    )
    # Parse the nested pricing JSON to extract the USD per-hour cost
    for pl in resp["PriceList"]:
        data = json.loads(pl)
        for tv in data["terms"]["OnDemand"].values():
            for dv in tv["priceDimensions"].values():
                return float(dv["pricePerUnit"]["USD"])
    return 0.0


def run(session=None, region="us-east-1", **parameters):
    if not session:
        session = boto3.Session(region_name=region)

    ec2 = session.client("ec2", region_name=region)
    pricing = session.client("pricing", region_name=region)

    # Step 1: List all running EC2 instances and count them by (instance_type, OS) combo
    paginator = ec2.get_paginator("describe_instances")
    combos: Counter = Counter()
    for page in paginator.paginate(
        Filters=[{"Name": "instance-state-name", "Values": ["running"]}]
    ):
        for res in page["Reservations"]:
            for inst in res["Instances"]:
                os_name = (
                    "Windows"
                    if inst.get("Platform", "").lower() == "windows"
                    else "Linux"
                )
                combos[(inst["InstanceType"], os_name)] += 1

    # Step 2: For each unique (instance_type, OS) pair, look up the on-demand price
    # and compute the subtotal cost (price * instance count)
    total = 0.0
    parts = []
    for (itype, os_name), count in sorted(combos.items()):
        price = _get_hourly_price(pricing, itype, os_name)
        subtotal = price * count
        total += subtotal
        parts.append(
            f"{count}x {itype} {os_name} @ ${price:.4f}/hr = ${subtotal:.4f}/hr"
        )

    # Step 3: Return the total hourly cost and a human-readable breakdown string
    return {
        "f6287f43-TotalHourlyCost": f"${total:.4f}",
        "f6287f43-Breakdown": " | ".join(parts),
    }


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
