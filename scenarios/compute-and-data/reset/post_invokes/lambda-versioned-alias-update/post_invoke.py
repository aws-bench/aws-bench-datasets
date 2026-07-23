"""Rollback for lambda-versioned-alias-update.

The mutation is the value of the Lambda's env var (the function code
hardcodes the key `OLD_TABLE_NAME` and reads the table name from it —
see scenario stack dynamodb_zx5kclfft.ts:59,74). Restoration is to set
that key back to the original `OldTableName` value, preserving any
other env vars the agent or scenario may have on the function.

Best-effort: errors print to stderr but the script exits 0 so the
trial-end hook doesn't error out and block the next trial.
"""

import os
import sys

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
FUNCTION_NAME = os.environ["EXPECTED_FUNCTION"]
OLD_TABLE = os.environ["EXPECTED_OLD_TABLE"]

# Key the function's code reads at runtime — mirrors the seeded
# environment in the CDK stack.
ENV_VAR_KEY = "OLD_TABLE_NAME"


def main() -> int:
    lam = boto3.client("lambda", region_name=REGION)
    errors: list[str] = []

    try:
        cfg = lam.get_function(FunctionName=FUNCTION_NAME)
    except ClientError as e:
        print(f"get_function: {e}", file=sys.stderr)
        return 0

    current_env = ((cfg.get("Configuration") or {}).get("Environment") or {}).get(
        "Variables"
    ) or {}
    if current_env.get(ENV_VAR_KEY) == OLD_TABLE:
        return 0

    new_env = dict(current_env)
    new_env[ENV_VAR_KEY] = OLD_TABLE

    try:
        lam.update_function_configuration(
            FunctionName=FUNCTION_NAME,
            Environment={"Variables": new_env},
        )
    except ClientError as e:
        errors.append(f"update_function_configuration: {e}")

    for err in errors:
        print(err, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
