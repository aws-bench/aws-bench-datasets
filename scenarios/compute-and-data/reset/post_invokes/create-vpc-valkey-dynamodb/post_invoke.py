"""Post-invoke for create-vpc-valkey-dynamodb.

Cleans up resources created by this task using agent-output.json:
Valkey/ElastiCache replication group, its cache subnet group, DynamoDB
table, and the non-default VPC with all its dependencies.

Best-effort: errors print to stderr but exit 0.
"""

import json
import os
import sys
import time
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
AGENT_OUTPUT_PATH = Path("/logs/agent/agent-output.json")


def _read_agent_output() -> dict:
    if AGENT_OUTPUT_PATH.exists():
        try:
            return json.loads(AGENT_OUTPUT_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _delete_replication_group(ec, group_id: str, errors: list[str]) -> None:
    try:
        ec.delete_replication_group(
            ReplicationGroupId=group_id,
            RetainPrimaryCluster=False,
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ReplicationGroupNotFoundFault":
            return
        errors.append(f"delete_replication_group {group_id}: {e}")
        return

    # Wait for deletion (up to 5 minutes)
    for _ in range(60):
        try:
            ec.describe_replication_groups(ReplicationGroupId=group_id)
            time.sleep(5)
        except ClientError as e:
            if "ReplicationGroupNotFoundFault" in str(e):
                break
            time.sleep(5)


def _delete_cache_subnet_group(ec, group_name: str, errors: list[str]) -> None:
    try:
        ec.delete_cache_subnet_group(CacheSubnetGroupName=group_name)
    except ClientError as e:
        if "CacheSubnetGroupNotFoundFault" not in str(e):
            errors.append(f"delete_cache_subnet_group {group_name}: {e}")


def _delete_dynamodb_table(dynamodb, table_name: str, errors: list[str]) -> None:
    try:
        dynamodb.delete_table(TableName=table_name)
    except ClientError as e:
        if e.response["Error"]["Code"] != "ResourceNotFoundException":
            errors.append(f"delete_table {table_name}: {e}")


def _delete_vpc(ec2, vpc_id: str, errors: list[str]) -> None:
    try:
        # Delete subnets
        resp = ec2.describe_subnets(Filters=[{"Name": "vpc-id", "Values": [vpc_id]}])
        for subnet in resp.get("Subnets", []):
            try:
                ec2.delete_subnet(SubnetId=subnet["SubnetId"])
            except ClientError as e:
                errors.append(f"delete_subnet {subnet['SubnetId']}: {e}")

        # Detach and delete internet gateways
        resp = ec2.describe_internet_gateways(
            Filters=[{"Name": "attachment.vpc-id", "Values": [vpc_id]}]
        )
        for igw in resp.get("InternetGateways", []):
            igw_id = igw["InternetGatewayId"]
            try:
                ec2.detach_internet_gateway(InternetGatewayId=igw_id, VpcId=vpc_id)
                ec2.delete_internet_gateway(InternetGatewayId=igw_id)
            except ClientError as e:
                errors.append(f"delete_igw {igw_id}: {e}")

        # Delete non-main route tables
        resp = ec2.describe_route_tables(
            Filters=[{"Name": "vpc-id", "Values": [vpc_id]}]
        )
        for rt in resp.get("RouteTables", []):
            is_main = any(
                assoc.get("Main", False) for assoc in rt.get("Associations", [])
            )
            if is_main:
                continue
            try:
                ec2.delete_route_table(RouteTableId=rt["RouteTableId"])
            except ClientError as e:
                errors.append(f"delete_route_table {rt['RouteTableId']}: {e}")

        # Delete non-default security groups
        resp = ec2.describe_security_groups(
            Filters=[{"Name": "vpc-id", "Values": [vpc_id]}]
        )
        for sg in resp.get("SecurityGroups", []):
            if sg["GroupName"] == "default":
                continue
            try:
                ec2.delete_security_group(GroupId=sg["GroupId"])
            except ClientError as e:
                errors.append(f"delete_security_group {sg['GroupId']}: {e}")

        # Delete the VPC
        ec2.delete_vpc(VpcId=vpc_id)
    except ClientError as e:
        errors.append(f"delete_vpc {vpc_id}: {e}")


def main() -> int:
    agent_output = _read_agent_output()
    if not agent_output:
        print("No agent output found — nothing to clean up.")
        return 0

    ec = boto3.client("elasticache", region_name=REGION)
    ec2 = boto3.client("ec2", region_name=REGION)
    dynamodb = boto3.client("dynamodb", region_name=REGION)
    errors: list[str] = []

    replication_group_id = agent_output.get("ReplicationGroupId", "")
    table_name = agent_output.get("DynamoTableName", "")
    vpc_id = agent_output.get("VpcId", "")

    # Delete replication group first (depends on subnet group which depends on VPC)
    subnet_group_name = ""
    if replication_group_id:
        # Grab the subnet group name before deleting
        try:
            resp = ec.describe_replication_groups(
                ReplicationGroupId=replication_group_id
            )
            groups = resp.get("ReplicationGroups", [])
            if groups:
                subnet_group_name = groups[0].get("CacheSubnetGroupName", "")
        except ClientError:
            pass
        _delete_replication_group(ec, replication_group_id, errors)

    # Delete cache subnet group (after replication group is gone)
    if subnet_group_name:
        _delete_cache_subnet_group(ec, subnet_group_name, errors)

    # Delete DynamoDB table
    if table_name:
        _delete_dynamodb_table(dynamodb, table_name, errors)

    # Delete VPC last (other resources depend on it)
    if vpc_id:
        _delete_vpc(ec2, vpc_id, errors)

    for err in errors:
        print(err, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
