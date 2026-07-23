"""Rollback for iotsitewise-windfarm-rollup-models.

Deletes WindFarmModel and WindTurbineModel asset models created by the
agent. Order matters: the parent (WindFarmModel) declares a hierarchy
into the child, so the parent must be deleted first; then the child.

Asset-model deletion is asynchronous (CREATING/DELETING/ACTIVE/FAILED).
We issue both deletes and don't block -- the next trial's pre_invoke will
verify a clean state.

Best-effort: errors print to stderr; exit 0.
"""

import os
import sys

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")

PARENT_NAME = "WindFarmModel"
CHILD_NAME = "WindTurbineModel"


def _find_id(client, name: str) -> str | None:
    try:
        paginator = client.get_paginator("list_asset_models")
        for page in paginator.paginate():
            for m in page.get("assetModelSummaries", []):
                if m.get("name") == name:
                    return m.get("id")
    except ClientError:
        return None
    return None


def _delete(client, model_id: str | None, label: str, errors: list[str]) -> None:
    if not model_id:
        return
    try:
        client.delete_asset_model(assetModelId=model_id)
    except ClientError as e:
        errors.append(f"delete {label} ({model_id}): {e}")


def main() -> int:
    client = boto3.client("iotsitewise", region_name=REGION)
    errors: list[str] = []

    parent_id = _find_id(client, PARENT_NAME)
    child_id = _find_id(client, CHILD_NAME)

    # Delete parent first (it owns the hierarchy referencing the child).
    _delete(client, parent_id, PARENT_NAME, errors)
    _delete(client, child_id, CHILD_NAME, errors)

    for err in errors:
        print(err, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
