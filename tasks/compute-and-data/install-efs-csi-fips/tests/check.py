"""Verifier for install-efs-csi-fips."""

import os
from pathlib import Path

import boto3
import yaml
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
CLUSTER_NAME = os.environ.get("CLUSTER_NAME", "")


@criterion(description="EFS CSI driver addon is installed on the cluster")
def efs_csi_addon_exists(workspace: Path) -> bool:
    if not CLUSTER_NAME:
        return False
    eks = boto3.client("eks", region_name=REGION)
    try:
        addons = eks.list_addons(clusterName=CLUSTER_NAME)["addons"]
        return "aws-efs-csi-driver" in addons
    except ClientError:
        return False


@criterion(
    description="EFS CSI addon reached a terminal installed state (ACTIVE or DEGRADED)"
)
def efs_csi_addon_active(workspace: Path) -> bool:
    if not CLUSTER_NAME:
        return False
    eks = boto3.client("eks", region_name=REGION)
    try:
        addon = eks.describe_addon(
            clusterName=CLUSTER_NAME, addonName="aws-efs-csi-driver"
        )
        status = addon["addon"]["status"]
        # No worker nodes, so the driver DaemonSet can't schedule; a successful install is DEGRADED, not ACTIVE.
        return status in ("ACTIVE", "DEGRADED")
    except ClientError:
        return False


@criterion(description="EFS CSI addon has FIPS enabled")
def efs_csi_fips_enabled(workspace: Path) -> bool:
    if not CLUSTER_NAME:
        return False
    eks = boto3.client("eks", region_name=REGION)
    try:
        addon = eks.describe_addon(
            clusterName=CLUSTER_NAME, addonName="aws-efs-csi-driver"
        )
        config_values = addon["addon"].get("configurationValues", "") or ""
        parsed = yaml.safe_load(config_values) if config_values else None
        return isinstance(parsed, dict) and parsed.get("useFIPS") is True
    except ClientError:
        return False
