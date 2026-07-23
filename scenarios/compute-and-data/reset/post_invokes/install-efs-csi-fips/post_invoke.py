"""Rollback for install-efs-csi-fips. Removes the EFS CSI addon."""

import os
import sys

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
CLUSTER_NAME = os.environ.get("CLUSTER_NAME", "")


def main() -> int:
    if not CLUSTER_NAME:
        print("No cluster name — nothing to clean up.")
        return 0
    eks = boto3.client("eks", region_name=REGION)
    try:
        eks.delete_addon(clusterName=CLUSTER_NAME, addonName="aws-efs-csi-driver")
        print(f"Removed EFS CSI addon from {CLUSTER_NAME}")
    except ClientError as e:
        print(f"Rollback note: {e}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
