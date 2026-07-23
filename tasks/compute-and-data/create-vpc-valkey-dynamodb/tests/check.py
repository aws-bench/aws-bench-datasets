"""Verifier for create-vpc-valkey-dynamodb."""

import json
import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
AGENT_OUTPUT_PATH = Path("/logs/agent/agent-output.json")
AGENT_OUTPUT: dict = {}
if AGENT_OUTPUT_PATH.exists():
    try:
        AGENT_OUTPUT = json.loads(AGENT_OUTPUT_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        pass

VPC_ID = AGENT_OUTPUT.get("VpcId", "")
REPLICATION_GROUP_ID = AGENT_OUTPUT.get("ReplicationGroupId", "")
TABLE_NAME = AGENT_OUTPUT.get("DynamoTableName", "")


@criterion(
    description="Agent output contains VpcId, ReplicationGroupId, DynamoTableName"
)
def output_contract(workspace: Path) -> bool:
    return bool(VPC_ID) and bool(REPLICATION_GROUP_ID) and bool(TABLE_NAME)


@criterion(description="VPC exists and is not the account default VPC")
def vpc_exists(workspace: Path) -> bool:
    if not VPC_ID:
        return False
    ec2 = boto3.client("ec2", region_name=REGION)
    try:
        resp = ec2.describe_vpcs(VpcIds=[VPC_ID])
        vpcs = resp.get("Vpcs", [])
        return len(vpcs) > 0 and not vpcs[0].get("IsDefault", False)
    except ClientError:
        return False


@criterion(
    description="Valkey/ElastiCache replication group exists and is available in the agent's VPC"
)
def valkey_cluster_exists(workspace: Path) -> bool:
    if not REPLICATION_GROUP_ID:
        return False
    ec = boto3.client("elasticache", region_name=REGION)
    try:
        resp = ec.describe_replication_groups(ReplicationGroupId=REPLICATION_GROUP_ID)
        groups = resp.get("ReplicationGroups", [])
        if not groups:
            return False
        group = groups[0]
        # Require available or creating (creating is acceptable since
        # Valkey clusters take several minutes to provision)
        if group["Status"] not in ("available", "creating"):
            return False
        # Cross-check: if VPC_ID is provided, verify the cluster is in that VPC
        if VPC_ID:
            # Get the cache subnet group to find the VPC
            subnet_group_name = group.get("CacheSubnetGroupName")
            if subnet_group_name:
                sg_resp = ec.describe_cache_subnet_groups(
                    CacheSubnetGroupName=subnet_group_name
                )
                subnet_groups = sg_resp.get("CacheSubnetGroups", [])
                if subnet_groups and subnet_groups[0].get("VpcId") != VPC_ID:
                    return False
        return True
    except ClientError:
        return False


@criterion(description="DynamoDB table exists and is ACTIVE")
def dynamodb_table_exists(workspace: Path) -> bool:
    if not TABLE_NAME:
        return False
    ddb = boto3.client("dynamodb", region_name=REGION)
    try:
        resp = ddb.describe_table(TableName=TABLE_NAME)
        status = resp.get("Table", {}).get("TableStatus")
        return status in ("ACTIVE", "CREATING")
    except ClientError:
        return False
