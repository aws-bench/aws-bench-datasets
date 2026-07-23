"""Programmatic verifier for lambda-versioned-alias-update.

Re-implements aws-bench-datasets/src/aws_bench_datasets/mutation_scripts/g6h7i8j9-k0l1-m234-n5o6-p7q8r9s0t1u2/validate.py.

The agent points the Validation Lambda at a new DynamoDB table by changing
the value of the env var that holds the table name (preserving the var key
so the function code keeps working). Verifier:
  1. confirms the function has an env var whose VALUE equals NEW_TABLE —
     either under the original key (OLD_TABLE_NAME) or under a new key
     whose name appears in the deployed function code,
  2. invokes the function and confirms the response isn't a code-level
     env-var lookup error (caused by renaming the key instead of the value).
"""

import io
import json
import os
import urllib.request
import zipfile
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
FUNCTION_NAME = os.environ["EXPECTED_FUNCTION"]
NEW_TABLE = os.environ["EXPECTED_NEW_TABLE"]


def _lambda():
    return boto3.client("lambda", region_name=REGION)


def _function_env() -> dict[str, str]:
    try:
        cfg = _lambda().get_function(FunctionName=FUNCTION_NAME)
    except ClientError:
        return {}
    return ((cfg.get("Configuration") or {}).get("Environment") or {}).get(
        "Variables"
    ) or {}


def _function_code_reads_var(var_name: str) -> bool:
    """Download the Lambda code and check if it references the given env var name.

    Matches common patterns: os.environ['VAR'], os.environ["VAR"],
    os.environ.get('VAR'), os.environ.get("VAR"), os.getenv('VAR').
    Avoids substring false positives (e.g., TABLE_NAME matching OLD_TABLE_NAME).
    """
    import re

    try:
        resp = _lambda().get_function(FunctionName=FUNCTION_NAME)
        code_url = resp["Code"]["Location"]
        code_zip = urllib.request.urlopen(code_url).read()
        # Pattern matches the var name in quotes (single or double) as a standalone reference
        pattern = re.compile(
            r"""(?:os\.environ\[|os\.environ\.get\(|os\.getenv\()"""
            r"""['"]""" + re.escape(var_name) + r"""['"]"""
        )
        with zipfile.ZipFile(io.BytesIO(code_zip)) as zf:
            for name in zf.namelist():
                source = zf.read(name).decode("utf-8", errors="ignore")
                if pattern.search(source):
                    return True
    except Exception:
        return False
    return False


@criterion(
    description="Lambda has an environment variable whose value points at the new validation table"
)
def env_var_points_at_new_table(workspace: Path) -> bool:
    env = _function_env()
    # Fast path 1: Agent updated the value of the original key directly
    if env.get("OLD_TABLE_NAME") == NEW_TABLE:
        return True
    # Fast path 2: Agent removed OLD_TABLE_NAME and added a new key with the correct value.
    # Since the original code reads OLD_TABLE_NAME, removing it means the agent must have
    # updated the code too (otherwise the function would crash with KeyError).
    if NEW_TABLE in env.values() and "OLD_TABLE_NAME" not in env:
        return True
    # Slow path: Both OLD_TABLE_NAME (with old value) and a new key (with new value) exist.
    # Ambiguous — could be dangling or could be a legitimate code update.
    # Download the code and check which key it actually reads.
    if NEW_TABLE in env.values():
        new_key = next((k for k, v in env.items() if v == NEW_TABLE), None)
        if new_key and _function_code_reads_var(new_key):
            return True
    return False


@criterion(
    description="Lambda invokes successfully without env-var lookup errors (KeyError / OLD_TABLE_NAME / TABLE_NAME)"
)
def lambda_invokes_with_new_table(workspace: Path) -> bool:
    """Functional check: the agent must change the env-var VALUE, not rename
    the KEY. If they renamed the key, the function code still tries to
    read the old key and crashes — KeyError surfaces in the response body.
    """
    try:
        resp = _lambda().invoke(
            FunctionName=FUNCTION_NAME,
            InvocationType="RequestResponse",
            Payload=json.dumps({"validation_id": "test-validation"}),
        )
    except ClientError:
        return False
    try:
        payload = json.loads(resp["Payload"].read())
    except (json.JSONDecodeError, KeyError):
        return False
    if payload.get("statusCode") == 500:
        try:
            error_msg = json.loads(payload.get("body") or "{}").get("error", "")
        except (json.JSONDecodeError, AttributeError):
            error_msg = ""
        if any(s in error_msg for s in ("OLD_TABLE_NAME", "TABLE_NAME", "KeyError")):
            return False
    # Any non-env-var-error response (200, 404, etc.) means the function
    # ran end-to-end and read the new env-var value successfully.
    return True
