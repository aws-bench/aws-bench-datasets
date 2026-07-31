"""Rollback for dms-rds-mysql-to-s3-tables.

Tears down the agent's DMS pipeline. Order matters:
  1. Stop and delete the replication task (must be stopped or stopped-error
     before delete).
  2. Delete the source and target endpoints (after the task is gone).
  3. Delete the replication instance (after endpoints; requires no
     associated tasks).
  4. Delete the subnet group (after the instance).

DMS replication-instance deletion takes 5-10 min and is async; we issue
the API call and don't block. The next trial creates fresh resources.

Best-effort: errors print to stderr; exit 0.
"""

import json
import os
import sys
import time
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

from reset import reset_data_plane

REGION = os.environ.get("AWS_REGION", "us-east-1")

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    AGENT_OUTPUT = {}

CHOSEN_INSTANCE = AGENT_OUTPUT.get("replication_instance_identifier") or ""
CHOSEN_TASK = AGENT_OUTPUT.get("replication_task_identifier") or ""


def _stop_and_delete_task(
    dms, errors: list[str]
) -> tuple[str | None, str | None, str | None]:
    """Returns (replication_instance_arn, source_endpoint_arn, target_endpoint_arn)
    so downstream cleanup can find them after the task is gone.
    """
    if not CHOSEN_TASK:
        return None, None, None
    try:
        resp = dms.describe_replication_tasks(
            Filters=[{"Name": "replication-task-id", "Values": [CHOSEN_TASK]}]
        )
    except ClientError as e:
        errors.append(f"describe task: {e}")
        return None, None, None
    tasks = resp.get("ReplicationTasks") or []
    if not tasks:
        return None, None, None
    task = tasks[0]
    task_arn = task.get("ReplicationTaskArn") or ""
    instance_arn = task.get("ReplicationInstanceArn")
    source_arn = task.get("SourceEndpointArn")
    target_arn = task.get("TargetEndpointArn")

    # Stop the task if it's running.
    status = task.get("Status")
    if status in {"running", "starting", "ready"}:
        try:
            dms.stop_replication_task(ReplicationTaskArn=task_arn)
        except ClientError as e:
            errors.append(f"stop task: {e}")
        # Wait briefly for stop to propagate.
        for _ in range(30):
            time.sleep(2)
            try:
                cur = (
                    dms.describe_replication_tasks(
                        Filters=[
                            {"Name": "replication-task-id", "Values": [CHOSEN_TASK]}
                        ]
                    ).get("ReplicationTasks")
                    or []
                )
                if not cur:
                    break
                if cur[0].get("Status") in {"stopped", "stopping", "failed"}:
                    break
            except ClientError:
                break

    try:
        dms.delete_replication_task(ReplicationTaskArn=task_arn)
    except ClientError as e:
        errors.append(f"delete task: {e}")

    return instance_arn, source_arn, target_arn


def _delete_endpoint(dms, endpoint_arn: str | None, errors: list[str]) -> None:
    if not endpoint_arn:
        return
    try:
        dms.delete_endpoint(EndpointArn=endpoint_arn)
    except ClientError as e:
        errors.append(f"delete endpoint {endpoint_arn}: {e}")


def _delete_instance(dms, instance_arn: str | None, errors: list[str]) -> str | None:
    """Returns the subnet group identifier so we can delete it after."""
    if not instance_arn and CHOSEN_INSTANCE:
        try:
            resp = dms.describe_replication_instances(
                Filters=[
                    {"Name": "replication-instance-id", "Values": [CHOSEN_INSTANCE]}
                ]
            )
        except ClientError as e:
            errors.append(f"describe instance: {e}")
            return None
        instances = resp.get("ReplicationInstances") or []
        if instances:
            instance_arn = instances[0].get("ReplicationInstanceArn")
            subnet_group_id = (
                instances[0]
                .get("ReplicationSubnetGroup", {})
                .get("ReplicationSubnetGroupIdentifier")
            )
        else:
            return None
    else:
        subnet_group_id = None
        if CHOSEN_INSTANCE:
            try:
                resp = dms.describe_replication_instances(
                    Filters=[
                        {"Name": "replication-instance-id", "Values": [CHOSEN_INSTANCE]}
                    ]
                )
                if resp.get("ReplicationInstances"):
                    subnet_group_id = (
                        resp["ReplicationInstances"][0]
                        .get("ReplicationSubnetGroup", {})
                        .get("ReplicationSubnetGroupIdentifier")
                    )
            except ClientError as e:
                errors.append(f"describe instance for subnet-group: {e}")

    if instance_arn:
        try:
            dms.delete_replication_instance(ReplicationInstanceArn=instance_arn)
        except ClientError as e:
            errors.append(f"delete instance: {e}")
    return subnet_group_id


def _delete_subnet_group(dms, subnet_group_id: str | None, errors: list[str]) -> None:
    if not subnet_group_id:
        return
    # Subnet group can only be deleted once the instance is gone (10+ min wait).
    # We attempt; if it fails with InvalidResourceStateFault, that's fine --
    # next-trial cleanup will reuse via env reset, or operator handles.
    try:
        dms.delete_replication_subnet_group(
            ReplicationSubnetGroupIdentifier=subnet_group_id
        )
    except ClientError as e:
        errors.append(
            f"delete subnet group {subnet_group_id} (likely waiting for instance delete): {e}"
        )


def main() -> int:
    dms = boto3.client("dms", region_name=REGION)
    errors: list[str] = []

    instance_arn, source_arn, target_arn = _stop_and_delete_task(dms, errors)
    _delete_endpoint(dms, source_arn, errors)
    _delete_endpoint(dms, target_arn, errors)
    subnet_group_id = _delete_instance(dms, instance_arn, errors)
    _delete_subnet_group(dms, subnet_group_id, errors)
    data_plane_errors = reset_data_plane(region=REGION)
    for err in errors + data_plane_errors:
        print(err, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
