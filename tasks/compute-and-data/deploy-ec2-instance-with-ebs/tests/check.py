"""Programmatic verifier for deploy-ec2-instance-with-ebs.

Checks that a t3.micro EC2 instance was deployed with correct config.
"""

import json
import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
VOLUME_ID = os.environ.get("VOLUME_ID", "")
VPC_ID = os.environ.get("VPC_ID", "")
SUBNET_ID = os.environ.get("SUBNET_ID", "")
SECURITY_GROUP_ID = os.environ.get("SECURITY_GROUP_ID", "")
IAM_ROLE_NAME = os.environ.get("IAM_ROLE_NAME", "")

AGENT_OUTPUT_PATH = Path("/logs/agent/agent-output.json")
AGENT_OUTPUT: dict = {}
if AGENT_OUTPUT_PATH.exists():
    try:
        AGENT_OUTPUT = json.loads(AGENT_OUTPUT_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        pass

INSTANCE_ID = AGENT_OUTPUT.get("InstanceId", "")


@criterion(description="Agent output contains InstanceId and KeyName")
def output_contract(workspace: Path) -> bool:
    return bool(INSTANCE_ID) and bool(AGENT_OUTPUT.get("KeyName", ""))


@criterion(description="Instance is running as t3.micro")
def instance_running_t3_micro(workspace: Path) -> bool:
    if not INSTANCE_ID:
        return False
    ec2 = boto3.client("ec2", region_name=REGION)
    try:
        resp = ec2.describe_instances(InstanceIds=[INSTANCE_ID])
        inst = resp["Reservations"][0]["Instances"][0]
        return inst["State"]["Name"] == "running" and inst["InstanceType"] == "t3.micro"
    except (ClientError, IndexError, KeyError):
        return False


@criterion(description="Instance has the agent-reported SSH key pair attached")
def has_key_pair(workspace: Path) -> bool:
    if not INSTANCE_ID:
        return False
    reported_key = AGENT_OUTPUT.get("KeyName", "")
    if not reported_key:
        return False
    ec2 = boto3.client("ec2", region_name=REGION)
    try:
        resp = ec2.describe_instances(InstanceIds=[INSTANCE_ID])
        inst = resp["Reservations"][0]["Instances"][0]
        return inst.get("KeyName") == reported_key
    except (ClientError, IndexError, KeyError):
        return False


@criterion(description="Instance is in correct VPC and subnet")
def correct_network(workspace: Path) -> bool:
    if not INSTANCE_ID:
        return False
    ec2 = boto3.client("ec2", region_name=REGION)
    try:
        resp = ec2.describe_instances(InstanceIds=[INSTANCE_ID])
        inst = resp["Reservations"][0]["Instances"][0]
        vpc_ok = not VPC_ID or inst.get("VpcId") == VPC_ID
        subnet_ok = not SUBNET_ID or inst.get("SubnetId") == SUBNET_ID
        return vpc_ok and subnet_ok
    except (ClientError, IndexError, KeyError):
        return False


@criterion(description="Correct security group and IAM role attached")
def correct_sg_and_iam(workspace: Path) -> bool:
    if not INSTANCE_ID:
        return False
    ec2 = boto3.client("ec2", region_name=REGION)
    try:
        resp = ec2.describe_instances(InstanceIds=[INSTANCE_ID])
        inst = resp["Reservations"][0]["Instances"][0]
        sg_ids = [sg["GroupId"] for sg in inst.get("SecurityGroups", [])]
        sg_ok = not SECURITY_GROUP_ID or SECURITY_GROUP_ID in sg_ids
        iam_ok = True
        if IAM_ROLE_NAME:
            profile = inst.get("IamInstanceProfile")
            if not profile:
                iam_ok = False
            else:
                iam = boto3.client("iam")
                profile_name = profile["Arn"].split("/")[-1]
                details = iam.get_instance_profile(InstanceProfileName=profile_name)
                roles = [
                    r["RoleName"] for r in details["InstanceProfile"].get("Roles", [])
                ]
                iam_ok = IAM_ROLE_NAME in roles
        return sg_ok and iam_ok
    except (ClientError, IndexError, KeyError):
        return False


@criterion(description="EBS volume attached to instance")
def volume_attached(workspace: Path) -> bool:
    if not INSTANCE_ID or not VOLUME_ID:
        return False
    ec2 = boto3.client("ec2", region_name=REGION)
    try:
        vols = ec2.describe_volumes(
            Filters=[{"Name": "attachment.instance-id", "Values": [INSTANCE_ID]}]
        )["Volumes"]
        return any(v["VolumeId"] == VOLUME_ID for v in vols)
    except ClientError:
        return False
