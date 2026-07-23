"""Shared data-plane reset for create-eks-cluster.

Scans EKS clusters in the region and deletes any deployed in the
specified VPC. Handles nodegroup and Fargate profile cleanup before
cluster deletion.

Imported and called by both pre_invoke and post_invoke. Config is read from environment variables.
Best-effort: returns a list of error strings rather than raising.
"""

import os
import time

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1"))
VPC_ID = os.environ.get("VPC_ID", "")


def reset_data_plane(
    session: boto3.Session | None = None, region: str = REGION
) -> list[str]:
    """Delete EKS clusters deployed in the specified VPC.

    Deletes nodegroups and Fargate profiles first (required before
    cluster deletion), then deletes the cluster itself. Does not wait
    for full cluster deletion to avoid exceeding hook timeouts.

    Returns a list of error strings (empty on success). Never raises for
    per-resource failures.
    """
    if not VPC_ID:
        return ["VPC_ID not set; skipping reset"]

    if session is None:
        session = boto3.Session(region_name=region)
    eks = session.client("eks", region_name=region)
    errors: list[str] = []

    # List all clusters
    cluster_names: list[str] = []
    try:
        paginator = eks.get_paginator("list_clusters")
        for page in paginator.paginate():
            cluster_names.extend(page.get("clusters", []))
    except ClientError as e:
        errors.append(f"list_clusters: {e}")
        return errors

    for cluster_name in cluster_names:
        # Check if this cluster is in our target VPC
        try:
            resp = eks.describe_cluster(name=cluster_name)
            cluster_vpc = resp["cluster"]["resourcesVpcConfig"]["vpcId"]
            if cluster_vpc != VPC_ID:
                continue
            cluster_status = resp["cluster"]["status"]
            if cluster_status == "DELETING":
                continue
        except ClientError as e:
            errors.append(f"describe_cluster {cluster_name}: {e}")
            continue

        # Delete nodegroups first (required before cluster deletion)
        try:
            ng_paginator = eks.get_paginator("list_nodegroups")
            for page in ng_paginator.paginate(clusterName=cluster_name):
                for ng_name in page.get("nodegroups", []):
                    try:
                        eks.delete_nodegroup(
                            clusterName=cluster_name, nodegroupName=ng_name
                        )
                    except ClientError as e:
                        if e.response["Error"]["Code"] != "ResourceNotFoundException":
                            errors.append(
                                f"delete_nodegroup {cluster_name}/{ng_name}: {e}"
                            )
        except ClientError as e:
            errors.append(f"list_nodegroups {cluster_name}: {e}")

        # Wait for nodegroups to be deleted
        try:
            for _ in range(60):  # up to 5 minutes
                remaining = []
                ng_paginator = eks.get_paginator("list_nodegroups")
                for page in ng_paginator.paginate(clusterName=cluster_name):
                    remaining.extend(page.get("nodegroups", []))
                if not remaining:
                    break
                time.sleep(5)
        except ClientError:
            pass

        # Delete Fargate profiles one at a time (EKS allows only one
        # profile to be in DELETING state at a time per cluster)
        try:
            fp_names: list[str] = []
            fp_paginator = eks.get_paginator("list_fargate_profiles")
            for page in fp_paginator.paginate(clusterName=cluster_name):
                fp_names.extend(page.get("fargateProfileNames", []))
            for fp_name in fp_names:
                try:
                    eks.delete_fargate_profile(
                        clusterName=cluster_name, fargateProfileName=fp_name
                    )
                    # Wait for this profile to be deleted before the next
                    for _ in range(60):  # up to 5 minutes
                        try:
                            eks.describe_fargate_profile(
                                clusterName=cluster_name,
                                fargateProfileName=fp_name,
                            )
                            time.sleep(5)
                        except ClientError as inner_e:
                            if (
                                inner_e.response["Error"]["Code"]
                                == "ResourceNotFoundException"
                            ):
                                break
                            time.sleep(5)
                except ClientError as e:
                    if e.response["Error"]["Code"] != "ResourceNotFoundException":
                        errors.append(
                            f"delete_fargate_profile {cluster_name}/{fp_name}: {e}"
                        )
        except ClientError as e:
            errors.append(f"list_fargate_profiles {cluster_name}: {e}")

        # Delete the cluster
        try:
            eks.delete_cluster(name=cluster_name)
        except ClientError as e:
            if e.response["Error"]["Code"] != "ResourceNotFoundException":
                errors.append(f"delete_cluster {cluster_name}: {e}")

    return errors
