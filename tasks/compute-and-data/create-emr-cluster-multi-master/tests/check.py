"""Verifier for create-emr-cluster-multi-master."""

import json
import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = "ap-southeast-1"
AGENT_OUTPUT_PATH = Path("/logs/agent/agent-output.json")
AGENT_OUTPUT: dict = {}
if AGENT_OUTPUT_PATH.exists():
    try:
        AGENT_OUTPUT = json.loads(AGENT_OUTPUT_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        pass

CLUSTER_ID = AGENT_OUTPUT.get("EMRClusterId", "")


@criterion(description="Agent output contains EMRClusterId")
def output_contract(workspace: Path) -> bool:
    return bool(CLUSTER_ID)


@criterion(description="EMR cluster exists and is not terminated")
def cluster_exists(workspace: Path) -> bool:
    if not CLUSTER_ID:
        return False
    emr = boto3.client("emr", region_name=REGION)
    try:
        cluster = emr.describe_cluster(ClusterId=CLUSTER_ID)["Cluster"]
        state = cluster.get("Status", {}).get("State", "")
        return state not in ("TERMINATED", "TERMINATED_WITH_ERRORS")
    except ClientError:
        return False


@criterion(description="Cluster has 3 master nodes with m7g.xlarge")
def correct_master_config(workspace: Path) -> bool:
    if not CLUSTER_ID:
        return False
    emr = boto3.client("emr", region_name=REGION)
    try:
        groups = emr.list_instance_groups(ClusterId=CLUSTER_ID)["InstanceGroups"]
        masters = [g for g in groups if g.get("InstanceGroupType") == "MASTER"]
        if not masters:
            return False
        m = masters[0]
        return (
            m.get("RequestedInstanceCount", 0) == 3
            and m.get("InstanceType") == "m7g.xlarge"
        )
    except ClientError:
        return False


@criterion(description="Cluster has placement group configuration for master nodes")
def has_placement_group(workspace: Path) -> bool:
    if not CLUSTER_ID:
        return False
    emr = boto3.client("emr", region_name=REGION)
    try:
        cluster = emr.describe_cluster(ClusterId=CLUSTER_ID)["Cluster"]
        placement_groups = cluster.get("PlacementGroups", [])
        master_pg = [
            pg for pg in placement_groups if pg.get("InstanceRole") == "MASTER"
        ]
        return len(master_pg) == 1 and master_pg[0].get("PlacementStrategy") in (
            "SPREAD",
            "CLUSTER",
            "PARTITION",
        )
    except ClientError:
        return False


@criterion(
    description="Exactly 1 core node of type m7g.xlarge and no task instance groups"
)
def correct_core_node_and_no_extra_groups(workspace: Path) -> bool:
    if not CLUSTER_ID:
        return False
    emr = boto3.client("emr", region_name=REGION)
    try:
        groups = emr.list_instance_groups(ClusterId=CLUSTER_ID)["InstanceGroups"]
        core_groups = [g for g in groups if g.get("InstanceGroupType") == "CORE"]
        task_groups = [g for g in groups if g.get("InstanceGroupType") == "TASK"]
        # Exactly 1 core group with exactly 1 instance using m7g.xlarge, no task groups
        if len(core_groups) != 1 or len(task_groups) != 0:
            return False
        core = core_groups[0]
        return (
            core.get("RequestedInstanceCount", 0) == 1
            and core.get("InstanceType") == "m7g.xlarge"
        )
    except ClientError:
        return False
