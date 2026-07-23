"""Shared data-plane reset for cloudfront-with-lambda-edge.

Scans all CloudFront distributions for those with example.com as an
origin, then disables and deletes them along with associated Lambda@Edge
functions and IAM roles.

No CDK-managed distributions use example.com, so this is safe to run
in both pre_invoke and post_invoke.

Imported and called by both pre_invoke and post_invoke. Config is read from environment variables.
Best-effort: returns a list of error strings rather than raising.
"""

import json
import os
import time

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
TARGET_ORIGIN_DOMAIN = "example.com"


def _find_distributions_with_origin(cf, origin_domain: str) -> list[str]:
    """Find all distribution IDs that have the given origin domain."""
    dist_ids: list[str] = []
    try:
        paginator = cf.get_paginator("list_distributions")
        for page in paginator.paginate():
            dist_list = page.get("DistributionList", {})
            for dist in dist_list.get("Items") or []:
                origins = dist.get("Origins", {}).get("Items", [])
                for origin in origins:
                    if origin.get("DomainName") == origin_domain:
                        dist_ids.append(dist["Id"])
                        break
    except ClientError:
        pass
    return dist_ids


def _get_lambda_arns_from_distribution(cf, dist_id: str) -> list[str]:
    """Extract Lambda@Edge function ARNs from a distribution's behaviors."""
    arns: list[str] = []
    try:
        resp = cf.get_distribution_config(Id=dist_id)
        config = resp["DistributionConfig"]

        # Check default behavior
        default_behavior = config.get("DefaultCacheBehavior", {})
        for assoc in (default_behavior.get("LambdaFunctionAssociations") or {}).get(
            "Items"
        ) or []:
            arn = assoc.get("LambdaFunctionARN", "")
            if arn:
                arns.append(arn)

        # Check additional behaviors
        for behavior in (config.get("CacheBehaviors") or {}).get("Items") or []:
            for assoc in (behavior.get("LambdaFunctionAssociations") or {}).get(
                "Items"
            ) or []:
                arn = assoc.get("LambdaFunctionARN", "")
                if arn:
                    arns.append(arn)
    except ClientError:
        pass
    return arns


def _disable_and_delete_distribution(cf, dist_id: str, errors: list[str]) -> None:
    """Disable a distribution and then delete it once deployed."""
    try:
        resp = cf.get_distribution_config(Id=dist_id)
    except ClientError as e:
        if e.response["Error"]["Code"] == "NoSuchDistribution":
            return
        errors.append(f"get_distribution_config {dist_id}: {e}")
        return

    config = resp["DistributionConfig"]
    etag = resp["ETag"]

    # Disable if enabled
    if config.get("Enabled", False):
        config["Enabled"] = False
        try:
            resp = cf.update_distribution(
                Id=dist_id,
                DistributionConfig=config,
                IfMatch=etag,
            )
            etag = resp["ETag"]
        except ClientError as e:
            errors.append(f"disable_distribution {dist_id}: {e}")
            return

    # Wait for Deployed status (up to 8 minutes)
    for _ in range(32):
        try:
            resp = cf.get_distribution(Id=dist_id)
            status = resp["Distribution"]["Status"]
            if status == "Deployed":
                etag = resp["ETag"]
                break
        except ClientError:
            break
        time.sleep(15)
    else:
        errors.append(f"timeout waiting for distribution {dist_id} to deploy")
        return

    # Delete the distribution
    try:
        cf.delete_distribution(Id=dist_id, IfMatch=etag)
    except ClientError as e:
        errors.append(f"delete_distribution {dist_id}: {e}")


def _delete_lambda_function(
    lambda_client, function_name: str, errors: list[str]
) -> None:
    """Attempt to delete a Lambda function and all its versions.

    Lambda@Edge replicas may prevent deletion for hours after
    disassociation — this is best-effort.
    """
    # Delete all versions except $LATEST
    try:
        paginator = lambda_client.get_paginator("list_versions_by_function")
        for page in paginator.paginate(FunctionName=function_name):
            for version in page.get("Versions", []):
                if version["Version"] == "$LATEST":
                    continue
                try:
                    lambda_client.delete_function(
                        FunctionName=function_name,
                        Qualifier=version["Version"],
                    )
                except ClientError:
                    pass
    except ClientError:
        pass

    # Delete the function itself
    try:
        lambda_client.delete_function(FunctionName=function_name)
    except ClientError as e:
        code = e.response["Error"]["Code"]
        if code == "ResourceNotFoundException":
            return
        errors.append(f"delete_function {function_name}: {e}")


def _delete_iam_role(iam, role_name: str, errors: list[str]) -> None:
    """Delete an IAM role after removing its policies."""
    try:
        # Detach managed policies
        resp = iam.list_attached_role_policies(RoleName=role_name)
        for policy in resp.get("AttachedPolicies", []):
            iam.detach_role_policy(RoleName=role_name, PolicyArn=policy["PolicyArn"])

        # Delete inline policies
        resp = iam.list_role_policies(RoleName=role_name)
        for policy_name in resp.get("PolicyNames", []):
            iam.delete_role_policy(RoleName=role_name, PolicyName=policy_name)

        iam.delete_role(RoleName=role_name)
    except ClientError as e:
        if e.response["Error"]["Code"] == "NoSuchEntity":
            return
        errors.append(f"delete_role {role_name}: {e}")


def reset_data_plane(
    session: boto3.Session | None = None, region: str = REGION
) -> list[str]:
    """Find and delete CloudFront distributions with example.com origin
    and their associated Lambda@Edge functions and IAM roles.

    Returns a list of error strings (empty on success). Never raises for
    per-resource failures.
    """
    if session is None:
        session = boto3.Session(region_name=region)
    cf = session.client("cloudfront")
    lambda_client = session.client("lambda", region_name="us-east-1")
    iam = session.client("iam")
    errors: list[str] = []

    # Find distributions with example.com origin
    dist_ids = _find_distributions_with_origin(cf, TARGET_ORIGIN_DOMAIN)
    if not dist_ids:
        return []

    # Collect Lambda ARNs before deleting distributions
    lambda_arns: list[str] = []
    for dist_id in dist_ids:
        lambda_arns.extend(_get_lambda_arns_from_distribution(cf, dist_id))

    # Disable and delete distributions
    for dist_id in dist_ids:
        _disable_and_delete_distribution(cf, dist_id, errors)

    # Delete Lambda functions and their IAM roles
    seen_functions: set[str] = set()
    for arn in lambda_arns:
        # ARN format: arn:aws:lambda:region:account:function:name:version
        parts = arn.split(":")
        if len(parts) >= 7:
            function_name = parts[6]
        else:
            continue
        if function_name in seen_functions:
            continue
        seen_functions.add(function_name)

        # Get the role before deleting
        role_name = ""
        try:
            resp = lambda_client.get_function(FunctionName=function_name)
            role_arn = resp.get("Configuration", {}).get("Role", "")
            if role_arn:
                role_name = role_arn.split("/")[-1]
        except ClientError:
            pass

        _delete_lambda_function(lambda_client, function_name, errors)

        if role_name:
            _delete_iam_role(iam, role_name, errors)

    return errors
