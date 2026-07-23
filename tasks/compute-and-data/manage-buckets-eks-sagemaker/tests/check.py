"""Programmatic verifier for manage-buckets-eks-sagemaker.

Re-implements aws-bench-datasets/src/aws_bench_datasets/mutation_scripts/5d355480-8ede-40bf-8b7a-be177c41545e/validate.py.

The agent must:
  1. install the cert-manager and amazon-sagemaker-hyperpod-training-operator
     EKS add-ons on the seeded cluster,
  2. delete every object version (and delete marker) from the seeded
     versioned S3 buckets so each list_object_versions call returns empty.

Both the cluster and the buckets are framework-published — the agent
doesn't pick anything, so no agent-output.json contract is needed.
"""

import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
CLUSTER_NAME = os.environ["EXPECTED_CLUSTER"]
BUCKET_NAMES = tuple(
    b.strip() for b in os.environ["EXPECTED_BUCKETS_CSV"].split(",") if b.strip()
)

REQUIRED_ADDONS = ("cert-manager", "amazon-sagemaker-hyperpod-training-operator")


def _eks():
    return boto3.client("eks", region_name=REGION)


def _s3():
    return boto3.client("s3", region_name=REGION)


@criterion(
    description=f"both {REQUIRED_ADDONS!r} EKS add-ons are installed on the cluster"
)
def required_addons_installed(workspace: Path) -> bool:
    try:
        installed = _eks().list_addons(clusterName=CLUSTER_NAME).get("addons") or []
    except ClientError:
        return False
    return all(a in installed for a in REQUIRED_ADDONS)


@criterion(
    description="every seeded S3 bucket has zero object versions and zero delete markers"
)
def all_buckets_have_no_versions(workspace: Path) -> bool:
    """list_object_versions with MaxKeys=1 is enough — if either Versions
    or DeleteMarkers is non-empty, the bucket still has version history.
    """
    s3 = _s3()
    for b in BUCKET_NAMES:
        try:
            resp = s3.list_object_versions(Bucket=b, MaxKeys=1)
        except ClientError:
            return False
        if resp.get("Versions") or resp.get("DeleteMarkers"):
            return False
    return True
