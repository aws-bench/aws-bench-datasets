"""Shared data-plane reset for create-emr-cluster-multi-master.

Terminates all non-terminated EMR clusters in ap-southeast-1. Since no
other tasks or CDK resources use EMR in this region, any existing
cluster is from a prior run of this task.

Imported and called by both pre_invoke and post_invoke. Config is read from environment variables.
Best-effort: returns a list of error strings rather than raising.
"""

import os

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("EMR_MULTI_MASTER_REGION", "ap-southeast-1")


def reset_data_plane(
    session: boto3.Session | None = None, region: str = REGION
) -> list[str]:
    """Terminate all non-terminated EMR clusters in the region.

    Does not wait for termination to complete to avoid exceeding hook
    timeouts — EMR termination takes 5-10 minutes.

    Returns a list of error strings (empty on success). Never raises for
    per-resource failures.
    """
    if session is None:
        session = boto3.Session(region_name=region)
    emr = session.client("emr", region_name=region)
    errors: list[str] = []

    # List active clusters (all states except TERMINATED and TERMINATED_WITH_ERRORS)
    cluster_ids: list[str] = []
    try:
        paginator = emr.get_paginator("list_clusters")
        for page in paginator.paginate(
            ClusterStates=[
                "STARTING",
                "BOOTSTRAPPING",
                "RUNNING",
                "WAITING",
                "TERMINATING",
            ]
        ):
            for cluster in page.get("Clusters", []):
                state = cluster.get("Status", {}).get("State", "")
                if state != "TERMINATING":
                    cluster_ids.append(cluster["Id"])
    except ClientError as e:
        errors.append(f"list_clusters: {e}")
        return errors

    if not cluster_ids:
        return []

    try:
        emr.terminate_job_flows(JobFlowIds=cluster_ids)
    except ClientError as e:
        errors.append(f"terminate_job_flows {cluster_ids}: {e}")

    return errors
