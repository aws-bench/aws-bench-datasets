"""Programmatic verifier for ipam-pool-and-vpc.

Re-implements aws-bench-datasets/src/aws_bench_datasets/mutation_scripts/d3e4f5g6-h7i8-j901-k2l3-m4n5o6p7q8r9/validate.py.

The agent must create a VPC whose CIDR is allocated from the seeded IPAM
private pool (or any of its child pools). Verifier walks the pool's
allocations recursively and confirms one of them is a `vpc` resource in
state `available`.
"""

import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_REGION", "us-east-1")
POOL_ID = os.environ["EXPECTED_IPAM_POOL_ID"]


def _ec2():
    return boto3.client("ec2", region_name=REGION)


def _find_vpc_in_pool_tree(pool_id: str, seen: set[str]) -> str | None:
    """Walk allocations recursively. Return first VPC ResourceId found, or None.

    `seen` guards against cycles (defensive — IPAM trees shouldn't cycle).
    Any ClientError on a pool lookup just stops that branch's recursion.
    """
    if pool_id in seen:
        return None
    seen.add(pool_id)
    try:
        allocs = (
            _ec2()
            .get_ipam_pool_allocations(IpamPoolId=pool_id)
            .get("IpamPoolAllocations", [])
        )
    except ClientError:
        return None
    for a in allocs:
        rt = a.get("ResourceType")
        rid = a.get("ResourceId")
        if rt == "vpc" and rid:
            return rid
        if rt == "ipam-pool" and rid:
            found = _find_vpc_in_pool_tree(rid, seen)
            if found:
                return found
    return None


@criterion(
    description="VPC allocated from the seeded IPAM private pool (or child) exists and is available"
)
def vpc_allocated_from_pool(workspace: Path) -> bool:
    vpc_id = _find_vpc_in_pool_tree(POOL_ID, set())
    if not vpc_id:
        return False
    try:
        resp = _ec2().describe_vpcs(VpcIds=[vpc_id])
    except ClientError:
        return False
    vpcs = resp.get("Vpcs") or []
    if not vpcs:
        return False
    return vpcs[0].get("State") == "available"
