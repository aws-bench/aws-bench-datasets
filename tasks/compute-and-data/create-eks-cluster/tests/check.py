"""Verifier for create-eks-cluster."""

import json
import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_REGION", "us-east-1")
VPC_ID = os.environ.get("VPC_ID", "")
SUBNET_ID_1 = os.environ.get("SUBNET_ID_1", "")
SUBNET_ID_2 = os.environ.get("SUBNET_ID_2", "")
AGENT_OUTPUT_PATH = Path("/logs/agent/agent-output.json")
AGENT_OUTPUT: dict = {}
if AGENT_OUTPUT_PATH.exists():
    try:
        AGENT_OUTPUT = json.loads(AGENT_OUTPUT_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        pass

CLUSTER_NAME = AGENT_OUTPUT.get("eks_cluster_name", "")


@criterion(description="Agent output contains eks_cluster_name")
def output_contract(workspace: Path) -> bool:
    return bool(CLUSTER_NAME)


@criterion(description="EKS cluster exists and is active or creating")
def cluster_exists(workspace: Path) -> bool:
    if not CLUSTER_NAME:
        return False
    eks = boto3.client("eks", region_name=REGION)
    try:
        resp = eks.describe_cluster(name=CLUSTER_NAME)
        status = resp["cluster"]["status"]
        return status in ("ACTIVE", "CREATING")
    except ClientError:
        return False


@criterion(description="Cluster uses Kubernetes 1.33")
def correct_k8s_version(workspace: Path) -> bool:
    if not CLUSTER_NAME:
        return False
    eks = boto3.client("eks", region_name=REGION)
    try:
        resp = eks.describe_cluster(name=CLUSTER_NAME)
        version = resp["cluster"].get("version", "")
        return version.startswith("1.33")
    except ClientError:
        return False


@criterion(description="Cluster is deployed in the specified VPC")
def correct_vpc(workspace: Path) -> bool:
    if not CLUSTER_NAME or not VPC_ID:
        return False
    eks = boto3.client("eks", region_name=REGION)
    try:
        resp = eks.describe_cluster(name=CLUSTER_NAME)
        cluster_vpc = resp["cluster"]["resourcesVpcConfig"]["vpcId"]
        return cluster_vpc == VPC_ID
    except (ClientError, KeyError):
        return False


@criterion(description="Cluster uses both specified subnets")
def correct_subnets(workspace: Path) -> bool:
    if not CLUSTER_NAME or not SUBNET_ID_1 or not SUBNET_ID_2:
        return False
    eks = boto3.client("eks", region_name=REGION)
    try:
        resp = eks.describe_cluster(name=CLUSTER_NAME)
        cluster_subnets = set(resp["cluster"]["resourcesVpcConfig"]["subnetIds"])
        return {SUBNET_ID_1, SUBNET_ID_2}.issubset(cluster_subnets)
    except (ClientError, KeyError):
        return False
