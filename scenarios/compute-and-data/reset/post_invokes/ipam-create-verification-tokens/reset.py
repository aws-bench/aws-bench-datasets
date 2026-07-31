"""Shared control-plane reset for ipam-create-verification-tokens.

Deletes every external-resource verification token on the seeded IPAM so
each trial starts from zero.
"""

import os
import time

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
IPAM_ID = os.environ.get("EXPECTED_IPAM_ID", "")


def reset_control_plane(
    session: boto3.Session | None = None, region: str = REGION
) -> list[str]:
    """Delete all verification tokens on the seeded IPAM.

    Returns a list of error strings (empty on success). Never raises for
    per-resource failures.
    """
    if not IPAM_ID:
        return ["EXPECTED_IPAM_ID not set; skipping reset"]

    if session is None:
        session = boto3.Session(region_name=region)
    ec2 = session.client("ec2", region_name=region)

    for _ in range(30):
        try:
            resp = ec2.describe_ipam_external_resource_verification_tokens(
                Filters=[{"Name": "ipam-id", "Values": [IPAM_ID]}]
            )
        except ClientError as e:
            return [
                f"describe_ipam_external_resource_verification_tokens {IPAM_ID}: {e}"
            ]
        tokens = resp.get("IpamExternalResourceVerificationTokens") or []
        if not tokens:
            return []
        for token in tokens:
            try:
                ec2.delete_ipam_external_resource_verification_token(
                    IpamExternalResourceVerificationTokenId=token[
                        "IpamExternalResourceVerificationTokenId"
                    ]
                )
            except ClientError:
                pass
        time.sleep(2)

    return [f"tokens still present on {IPAM_ID} after reset timeout"]
