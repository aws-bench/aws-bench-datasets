"""
Setup script for stack opensearch-60603f075 (api-and-observability).
Deregisters placeholder IPs from both ALB target groups and registers stale IPs
to simulate a post-blue/green deployment where ENIs have rotated.
"""

from typing import Optional

import boto3
import sys
from botocore.config import Config

config = Config(connect_timeout=5, read_timeout=60)

REGION = "us-east-1"
STACK_NAME = "api-and-observability-opensearch-60603f075-us-east-1"
STALE_IPS = ["10.80.4.37", "10.80.8.112"]


def run(session: Optional[boto3.Session] = None, region: str = REGION, **parameters):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY")

    cfn = session.client("cloudformation", config=config, region_name=region)
    ec2 = session.client("ec2", config=config, region_name=region)
    elbv2 = session.client("elbv2", config=config, region_name=region)

    outputs = {
        o["OutputKey"]: o["OutputValue"]
        for o in cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]["Outputs"]
    }

    domain_name = outputs["DomainName"]
    dashboards_tg_arn = outputs["DashboardsTgArn"]
    api_tg_arn = outputs["ApiTgArn"]

    enis = ec2.describe_network_interfaces(
        Filters=[
            {"Name": "description", "Values": [f"ES {domain_name}"]},
            {"Name": "status", "Values": ["in-use"]},
        ]
    )["NetworkInterfaces"]
    actual_ips = [eni["PrivateIpAddress"] for eni in enis]
    print(f"Actual OpenSearch ENI IPs: {actual_ips}")

    for tg_arn, tg_name in [(dashboards_tg_arn, "dashboards"), (api_tg_arn, "api")]:
        print(f"Configuring {tg_name} target group")

        current = elbv2.describe_target_health(TargetGroupArn=tg_arn)
        current_targets = [
            {"Id": t["Target"]["Id"], "Port": t["Target"]["Port"]}
            for t in current["TargetHealthDescriptions"]
        ]
        if current_targets:
            elbv2.deregister_targets(TargetGroupArn=tg_arn, Targets=current_targets)
            print(f"Deregistered: {[t['Id'] for t in current_targets]}")

        elbv2.register_targets(
            TargetGroupArn=tg_arn,
            Targets=[{"Id": ip, "Port": 443} for ip in STALE_IPS],
        )
        print(f"Registered stale IPs: {STALE_IPS}")

    return {"success": True, "output_values": None}


if __name__ == "__main__":
    try:
        result = run()
        print(result)
        if isinstance(result, dict) and not result.get("success", True):
            sys.exit(1)
    except Exception as e:
        print(f"Setup failed: {e}", file=sys.stderr)
        sys.exit(1)
