"""Shared data-plane reset for create-emr-hbase-cluster.

Terminates EMR clusters in the region whose HBase WAL configuration
references the WAL bucket. This identifies clusters created by this
task without risking other EMR clusters in the same region.

Imported and called by both pre_invoke and post_invoke. Config is read from environment variables.
Best-effort: returns a list of error strings rather than raising.
"""

import os

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
WAL_BUCKET = os.environ.get("WAL_BUCKET", "")


def reset_data_plane(
    session: boto3.Session | None = None, region: str = REGION
) -> list[str]:
    """Terminate EMR clusters whose HBase config references the WAL bucket.

    Does not wait for termination to complete to avoid exceeding hook
    timeouts — EMR termination takes 5-10 minutes.

    Returns a list of error strings (empty on success). Never raises for
    per-resource failures.
    """
    if not WAL_BUCKET:
        return ["WAL_BUCKET not set; skipping reset"]

    if session is None:
        session = boto3.Session(region_name=region)
    emr = session.client("emr", region_name=region)
    errors: list[str] = []

    # List active clusters
    cluster_ids_to_terminate: list[str] = []
    try:
        paginator = emr.get_paginator("list_clusters")
        for page in paginator.paginate(
            ClusterStates=["STARTING", "BOOTSTRAPPING", "RUNNING", "WAITING"]
        ):
            for cluster in page.get("Clusters", []):
                cluster_id = cluster["Id"]
                # Check if this cluster's config references the WAL bucket
                try:
                    resp = emr.describe_cluster(ClusterId=cluster_id)
                    configs = resp.get("Cluster", {}).get("Configurations", [])
                    for cfg in configs:
                        if cfg.get("Classification") == "hbase-site":
                            props = cfg.get("Properties", {})
                            wal_dir = props.get("hbase.wal.dir", "")
                            if WAL_BUCKET in wal_dir:
                                cluster_ids_to_terminate.append(cluster_id)
                                break
                except ClientError as e:
                    errors.append(f"describe_cluster {cluster_id}: {e}")
    except ClientError as e:
        errors.append(f"list_clusters: {e}")
        return errors

    if not cluster_ids_to_terminate:
        return errors

    try:
        emr.terminate_job_flows(JobFlowIds=cluster_ids_to_terminate)
    except ClientError as e:
        errors.append(f"terminate_job_flows {cluster_ids_to_terminate}: {e}")

    return errors
