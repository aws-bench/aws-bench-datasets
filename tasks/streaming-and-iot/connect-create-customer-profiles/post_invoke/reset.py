"""Data-plane reset for connect-create-customer-profiles."""

import os

import boto3
from botocore.exceptions import BotoCoreError, ClientError

_AWS_ERRORS = (ClientError, BotoCoreError)

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
DOMAIN_NAME = os.environ.get("DOMAIN_NAME", "")
ACCOUNT_ID_1 = os.environ.get("ACCOUNT_ID_1", "")
ACCOUNT_ID_2 = os.environ.get("ACCOUNT_ID_2", "")


def _delete_profiles_for_account(
    client, account_number: str, errors: list[str]
) -> None:
    if not DOMAIN_NAME or not account_number:
        return
    next_token = None
    while True:
        kwargs = dict(
            DomainName=DOMAIN_NAME, KeyName="_account", Values=[account_number]
        )
        if next_token:
            kwargs["NextToken"] = next_token
        try:
            resp = client.search_profiles(**kwargs)
        except _AWS_ERRORS as e:
            errors.append(f"search_profiles for {account_number}: {e}")
            return
        for item in resp.get("Items", []):
            pid = item.get("ProfileId")
            if not pid:
                continue
            try:
                client.delete_profile(DomainName=DOMAIN_NAME, ProfileId=pid)
            except _AWS_ERRORS as e:
                errors.append(f"delete_profile {pid}: {e}")
        next_token = resp.get("NextToken")
        if not next_token:
            break


def reset_data_plane(
    session: boto3.Session | None = None, region: str = REGION
) -> list[str]:
    """Delete every agent-created profile for the two target account numbers
    in this task's provided Customer Profiles domain.

    Clean-only: the baseline domain is empty, so nothing is reseeded. Scoped
    to this task's own domain and target accounts; the domain itself is left
    intact. Returns a list of error strings (empty on success); never raises.
    """
    if not DOMAIN_NAME:
        return []
    if session is None:
        session = boto3.Session(region_name=region)
    client = session.client("customer-profiles", region_name=region)
    errors: list[str] = []
    _delete_profiles_for_account(client, ACCOUNT_ID_1, errors)
    _delete_profiles_for_account(client, ACCOUNT_ID_2, errors)
    return errors
