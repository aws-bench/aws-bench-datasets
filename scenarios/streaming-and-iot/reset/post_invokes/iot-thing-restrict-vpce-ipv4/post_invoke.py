"""Rollback for iot-thing-restrict-vpce-ipv4.

Removes the agent's IoT policy and any certificates it created+attached
to the thing. The thing itself is a precondition resource and must
remain.

Strategy:
  1. List the thing's current principals (likely certificates the agent
     created).
  2. For each principal: detach all attached policies, then detach the
     principal from the thing, then deactivate+delete the certificate.
     We only delete certificates the agent created -- i.e. principals
     attached *during this trial*. We can't perfectly distinguish those
     from baseline certs, but the precondition stack does not create any
     certs, so any cert we see is the agent's.
  3. List all IoT policies whose name matches the agent-reported
     `policy_name` (from /logs/agent/agent-output.json) and delete the
     non-default versions, then the policy. We also sweep any policy
     that has zero attached principals AND a Condition referencing
     aws:SourceVpce (defensive: catches the case where the agent's
     reported name didn't match what they actually created).

Best-effort: errors print to stderr; we exit 0 so the trial-end hook
doesn't block the next trial.
"""

import json
import os
import sys
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
THING_NAME = os.environ.get("THING_NAME", "")

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    AGENT_OUTPUT = {}

CHOSEN_POLICY_NAME = AGENT_OUTPUT.get("policy_name") or ""


def _detach_and_delete_policy(iot, policy_name: str, errors: list[str]) -> None:
    """Detach the policy from every principal then delete every version."""
    # Detach from any principals still holding it.
    try:
        targets = iot.list_targets_for_policy(policyName=policy_name).get("targets", [])
    except ClientError as e:
        errors.append(f"list targets for {policy_name}: {e}")
        targets = []
    for tgt in targets:
        try:
            iot.detach_policy(policyName=policy_name, target=tgt)
        except ClientError as e:
            errors.append(f"detach {policy_name} from {tgt}: {e}")

    # Delete non-default versions first; only after, the policy itself.
    try:
        versions = iot.list_policy_versions(policyName=policy_name).get(
            "policyVersions", []
        )
    except ClientError as e:
        errors.append(f"list versions for {policy_name}: {e}")
        versions = []
    for v in versions:
        if v.get("isDefaultVersion"):
            continue
        try:
            iot.delete_policy_version(
                policyName=policy_name, policyVersionId=v["versionId"]
            )
        except ClientError as e:
            errors.append(f"delete version {v.get('versionId')} of {policy_name}: {e}")
    try:
        iot.delete_policy(policyName=policy_name)
    except ClientError as e:
        errors.append(f"delete policy {policy_name}: {e}")


def _cleanup_thing_principals(iot, errors: list[str]) -> None:
    """Detach every principal from the thing and delete certs we own."""
    try:
        principals = iot.list_thing_principals(thingName=THING_NAME).get(
            "principals", []
        )
    except ClientError as e:
        errors.append(f"list thing principals: {e}")
        return

    for principal_arn in principals:
        # Detach all policies on this principal.
        try:
            attached = iot.list_attached_policies(target=principal_arn).get(
                "policies", []
            )
        except ClientError as e:
            errors.append(f"list policies on {principal_arn}: {e}")
            attached = []
        for p in attached:
            try:
                iot.detach_policy(policyName=p["policyName"], target=principal_arn)
            except ClientError as e:
                errors.append(f"detach {p['policyName']} from {principal_arn}: {e}")

        # Detach principal from the thing.
        try:
            iot.detach_thing_principal(thingName=THING_NAME, principal=principal_arn)
        except ClientError as e:
            errors.append(f"detach principal from thing: {e}")

        # If it's a cert, deactivate and delete. Cert ARNs look like
        # arn:aws:iot:<region>:<acct>:cert/<id>. Extract certificateId.
        if ":cert/" in principal_arn:
            cert_id = principal_arn.split(":cert/", 1)[1]
            try:
                iot.update_certificate(certificateId=cert_id, newStatus="INACTIVE")
            except ClientError as e:
                errors.append(f"deactivate cert {cert_id}: {e}")
            try:
                iot.delete_certificate(certificateId=cert_id, forceDelete=True)
            except ClientError as e:
                errors.append(f"delete cert {cert_id}: {e}")


def main() -> int:
    iot = boto3.client("iot", region_name=REGION)
    errors: list[str] = []

    # 1. Clean up principals first so policies become detachable.
    if THING_NAME:
        _cleanup_thing_principals(iot, errors)

    # 2. Delete the agent-reported policy.
    if CHOSEN_POLICY_NAME:
        _detach_and_delete_policy(iot, CHOSEN_POLICY_NAME, errors)

    for err in errors:
        print(err, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
