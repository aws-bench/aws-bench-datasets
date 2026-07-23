"""Programmatic verifier for connect-create-customer-profiles.

Validates that the agent created Customer Profiles for two account
numbers in the precondition Customer Profiles domain.

Per AWS docs (https://docs.aws.amazon.com/customerprofiles/latest/APIReference/API_SearchProfiles.html):
  - SearchProfiles takes (DomainName, KeyName, Values).
  - The predefined `_account` key indexes the top-level AccountNumber
    field set by CreateProfile(AccountNumber=...).
  - No documented eventual-consistency lag between create and search.
"""

import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
DOMAIN_NAME = os.environ.get("DOMAIN_NAME", "")
ACCOUNT_ID_1 = os.environ.get("ACCOUNT_ID_1", "")
ACCOUNT_ID_2 = os.environ.get("ACCOUNT_ID_2", "")


def _profiles():
    return boto3.client("customer-profiles", region_name=REGION)


def _profile_count_for_account(account_number: str) -> int:
    """Return the number of profiles in the precondition domain whose
    AccountNumber equals `account_number`. Returns -1 on API error so
    callers can distinguish 'no profile' from 'API failed'.
    """
    if not DOMAIN_NAME or not account_number:
        return -1
    try:
        resp = _profiles().search_profiles(
            DomainName=DOMAIN_NAME,
            KeyName="_account",
            Values=[account_number],
        )
    except ClientError:
        return -1
    return len(resp.get("Items", []))


@criterion(description="Customer Profiles domain exists")
def domain_exists(workspace: Path) -> bool:
    if not DOMAIN_NAME:
        return False
    try:
        _profiles().get_domain(DomainName=DOMAIN_NAME)
    except ClientError:
        return False
    return True


@criterion(description="exactly one profile exists for the first account number")
def profile_for_account_1(workspace: Path) -> bool:
    return _profile_count_for_account(ACCOUNT_ID_1) == 1


@criterion(description="exactly one profile exists for the second account number")
def profile_for_account_2(workspace: Path) -> bool:
    return _profile_count_for_account(ACCOUNT_ID_2) == 1
