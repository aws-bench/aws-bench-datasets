"""Rollback for msk-lambda-esm-iam-sasl.

Tears down everything the agent created:
  1. Delete the event source mapping (sync delete; ESM goes through
     Deleting briefly).
  2. Delete the Lambda function.
  3. Detach managed policies + delete inline policies + delete the
     execution role.
  4. Wipe any objects the agent's Lambda wrote to the sink bucket.

We identify the agent's resources from /logs/agent/agent-output.json's
`lambda_function_name`. Defensive sweep: delete any ESM whose
EventSourceArn matches the precondition cluster ARN, in case the agent's
reported name didn't match what they actually created. The role gate is
"trusts lambda.amazonaws.com" (Lambda execution role pattern), so we
don't accidentally delete the QA admin/readonly roles.

Best-effort: errors print to stderr; we exit 0 so the trial-end hook
doesn't block the next trial.
"""

import json
import os
import sys
import time
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

from reset import reset_data_plane

CLUSTER_REGION = "us-east-1"

CLUSTER_ARN = os.environ.get("CLUSTER_ARN", "")
SINK_BUCKET_NAME = os.environ.get("SINK_BUCKET_NAME", "")

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    AGENT_OUTPUT = {}

CHOSEN_LAMBDA_NAME = AGENT_OUTPUT.get("lambda_function_name") or ""


def _find_matching_esms(
    lambda_client, errors: list[str]
) -> list[tuple[str, str | None]]:
    """Return [(esm_uuid, function_arn)] for ESMs that point at our cluster.
    We list ALL ESMs (no FunctionName filter) so the defensive sweep
    catches the case where the agent didn't accurately report their
    function name in agent-output.json.
    """
    matches: list[tuple[str, str | None]] = []
    try:
        paginator = lambda_client.get_paginator("list_event_source_mappings")
        for page in paginator.paginate():
            for esm in page.get("EventSourceMappings", []):
                if esm.get("EventSourceArn") == CLUSTER_ARN:
                    uuid = esm.get("UUID")
                    if uuid:
                        matches.append((uuid, esm.get("FunctionArn")))
    except ClientError as e:
        errors.append(f"list ESMs: {e}")
    return matches


def _detach_and_delete_role(role_arn: str | None, errors: list[str]) -> None:
    """Detach managed + inline policies and delete the role, gated on
    'trusts lambda.amazonaws.com' so we don't touch baseline roles.
    """
    if not role_arn:
        return
    role_name = role_arn.split("/")[-1]
    iam = boto3.client("iam")
    try:
        role = iam.get_role(RoleName=role_name)
    except ClientError as e:
        errors.append(f"get role {role_name}: {e}")
        return
    trust = role.get("Role", {}).get("AssumeRolePolicyDocument") or {}
    if isinstance(trust, str):
        try:
            trust = json.loads(trust)
        except json.JSONDecodeError:
            trust = {}
    statements = trust.get("Statement") or []
    if isinstance(statements, dict):
        statements = [statements]
    trusted_lambda = any(
        (s.get("Principal") or {}).get("Service", "")
        in ("lambda.amazonaws.com", ["lambda.amazonaws.com"])
        for s in statements
    )
    if not trusted_lambda:
        return

    try:
        attached = iam.list_attached_role_policies(RoleName=role_name).get(
            "AttachedPolicies", []
        )
    except ClientError as e:
        errors.append(f"list attached for {role_name}: {e}")
        attached = []
    for p in attached:
        try:
            iam.detach_role_policy(RoleName=role_name, PolicyArn=p["PolicyArn"])
        except ClientError as e:
            errors.append(f"detach {p['PolicyArn']} from {role_name}: {e}")

    try:
        inline = iam.list_role_policies(RoleName=role_name).get("PolicyNames", [])
    except ClientError as e:
        errors.append(f"list inline for {role_name}: {e}")
        inline = []
    for pn in inline:
        try:
            iam.delete_role_policy(RoleName=role_name, PolicyName=pn)
        except ClientError as e:
            errors.append(f"delete inline {pn} on {role_name}: {e}")

    try:
        iam.delete_role(RoleName=role_name)
    except ClientError as e:
        errors.append(f"delete role {role_name}: {e}")


def _wipe_sink_bucket(s3_client, errors: list[str]) -> None:
    """List + delete every object in the sink bucket so the next trial
    starts clean. The bucket itself stays (it's a precondition resource).
    """
    if not SINK_BUCKET_NAME:
        return
    try:
        paginator = s3_client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=SINK_BUCKET_NAME):
            keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
            if not keys:
                continue
            try:
                s3_client.delete_objects(
                    Bucket=SINK_BUCKET_NAME,
                    Delete={"Objects": keys, "Quiet": True},
                )
            except ClientError as e:
                errors.append(f"delete batch from {SINK_BUCKET_NAME}: {e}")
    except ClientError as e:
        errors.append(f"list {SINK_BUCKET_NAME}: {e}")


def main() -> int:
    lambda_client = boto3.client("lambda", region_name=CLUSTER_REGION)
    s3_client = boto3.client("s3", region_name=CLUSTER_REGION)
    errors: list[str] = []

    # 1. Delete every ESM bound to our cluster. Capture the function ARNs
    #    so we can clean up the Lambdas + roles too.
    function_arns_to_delete: set[str] = set()
    for uuid, fn_arn in _find_matching_esms(lambda_client, errors):
        try:
            lambda_client.delete_event_source_mapping(UUID=uuid)
        except ClientError as e:
            errors.append(f"delete ESM {uuid}: {e}")
        if fn_arn:
            function_arns_to_delete.add(fn_arn)

    # 2. Add the agent's reported function name even if no ESM was bound
    #    (e.g., the agent created the Lambda but never wired the ESM).
    if CHOSEN_LAMBDA_NAME:
        function_arns_to_delete.add(CHOSEN_LAMBDA_NAME)

    # 3. Delete each function and its execution role.
    for fn_id in function_arns_to_delete:
        # fn_id may be a name or an ARN; resolve to a role ARN before
        # deleting the function (after delete_function we lose access).
        try:
            cfg = lambda_client.get_function(FunctionName=fn_id).get(
                "Configuration", {}
            )
            role_arn = cfg.get("Role") or ""
        except ClientError as e:
            errors.append(f"get function {fn_id}: {e}")
            role_arn = ""

        try:
            lambda_client.delete_function(FunctionName=fn_id)
        except ClientError as e:
            errors.append(f"delete function {fn_id}: {e}")

        # Lambda-managed ENIs take ~20 min to disappear after the function
        # is deleted. We don't block on that here; the next trial will see
        # them in describe_network_interfaces but they won't interfere
        # because nothing reuses them.
        if role_arn:
            _detach_and_delete_role(role_arn, errors)

    # 4. Wipe sink bucket contents (bucket itself is precondition).
    _wipe_sink_bucket(s3_client, errors)

    data_plane_errors = reset_data_plane(region=CLUSTER_REGION)

    for err in errors + data_plane_errors:
        print(err, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
