"""Reset helpers for manage-buckets-eks-sagemaker: S3 baseline and EKS add-on teardown."""

import os

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
BUCKETS_CSV = os.environ.get("EXPECTED_BUCKETS_CSV", "")
SAGEMAKER_BUCKET = os.environ.get("SAGEMAKER_BUCKET", "")
CLUSTER_NAME = os.environ.get("EXPECTED_CLUSTER", "")
ADDONS_TO_UNINSTALL = ("cert-manager", "amazon-sagemaker-hyperpod-training-operator")

FILE1_CONTENT = b"sample content 1"
FILE2_CONTENT = b"sample content 2"
LIFECYCLE_KEY = "lifecycle-config.sh"
LIFECYCLE_CONTENT = b"#!/bin/bash\necho 'HyperPod instance initialized'\n"


def _clean_bucket(s3, bucket: str, errors: list[str]) -> None:
    """Delete every object version and delete marker in the bucket."""
    try:
        paginator = s3.get_paginator("list_object_versions")
        for page in paginator.paginate(Bucket=bucket):
            to_delete: list[dict] = []
            for v in page.get("Versions") or []:
                to_delete.append({"Key": v["Key"], "VersionId": v["VersionId"]})
            for d in page.get("DeleteMarkers") or []:
                to_delete.append({"Key": d["Key"], "VersionId": d["VersionId"]})
            if to_delete:
                s3.delete_objects(
                    Bucket=bucket, Delete={"Objects": to_delete, "Quiet": True}
                )
    except ClientError as e:
        errors.append(f"clean {bucket}: {e}")


def _seed_service_bucket(s3, bucket: str, errors: list[str]) -> None:
    """Re-put the two seeded sample files for a service bucket."""
    service = bucket.split("-service-", 1)[0]
    try:
        s3.put_object(Bucket=bucket, Key=f"{service}-file1.txt", Body=FILE1_CONTENT)
        s3.put_object(Bucket=bucket, Key=f"{service}-file2.txt", Body=FILE2_CONTENT)
    except ClientError as e:
        errors.append(f"seed {bucket}: {e}")


def _seed_sagemaker_bucket(s3, bucket: str, errors: list[str]) -> None:
    """Re-put the seeded lifecycle-config.sh for the SageMaker bucket."""
    try:
        s3.put_object(Bucket=bucket, Key=LIFECYCLE_KEY, Body=LIFECYCLE_CONTENT)
    except ClientError as e:
        errors.append(f"seed {bucket}: {e}")


def reset_data_plane(
    session: boto3.Session | None = None, region: str = REGION
) -> list[str]:
    """Restore the seeded S3 baseline for every provided bucket.

    Cleans each bucket (deletes all versions and delete markers) then re-puts
    the byte-identical seeded objects. Returns a list of error strings and
    never raises for a per-resource failure.
    """
    buckets = [b.strip() for b in BUCKETS_CSV.split(",") if b.strip()]
    if not buckets and not SAGEMAKER_BUCKET:
        return []
    if session is None:
        session = boto3.Session(region_name=region)
    s3 = session.client("s3", region_name=region)
    errors: list[str] = []
    for bucket in buckets:
        _clean_bucket(s3, bucket, errors)
        _seed_service_bucket(s3, bucket, errors)
    if SAGEMAKER_BUCKET:
        _clean_bucket(s3, SAGEMAKER_BUCKET, errors)
        _seed_sagemaker_bucket(s3, SAGEMAKER_BUCKET, errors)
    return errors


def uninstall_addons(
    session: boto3.Session | None = None, region: str = REGION
) -> list[str]:
    """Delete the two agent-installed EKS add-ons; no-op when the cluster is unset or the add-ons are absent."""
    if not CLUSTER_NAME:
        return []
    if session is None:
        session = boto3.Session(region_name=region)
    eks = session.client("eks", region_name=region)
    errors: list[str] = []
    try:
        installed = eks.list_addons(clusterName=CLUSTER_NAME).get("addons") or []
    except ClientError as e:
        return [f"list_addons: {e}"]
    for addon in ADDONS_TO_UNINSTALL:
        if addon not in installed:
            continue
        try:
            eks.delete_addon(clusterName=CLUSTER_NAME, addonName=addon)
        except ClientError as e:
            if e.response["Error"]["Code"] != "ResourceNotFoundException":
                errors.append(f"delete_addon {addon}: {e}")
    return errors
