"""Rollback for ecs-on-ec2-with-cloudmap.

Tears down the agent-created stack:
  1. Update service desiredCount=0 + force-delete it.
  2. Deregister the agent's task-definition revisions (best-effort).
  3. Deregister + delete the Cloud Map service.
  4. Delete the Cloud Map namespace.

The precondition cluster + ASG + LaunchTemplate stay.

Best-effort: errors print to stderr; exit 0.
"""

import json
import os
import sys
import time
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
CLUSTER_NAME = os.environ.get("CLUSTER_NAME", "")

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    AGENT_OUTPUT = {}

CHOSEN_SERVICE_NAME = AGENT_OUTPUT.get("service_name") or ""
CHOSEN_NAMESPACE_NAME = AGENT_OUTPUT.get("namespace_name") or ""
CHOSEN_CLOUDMAP_SERVICE_NAME = AGENT_OUTPUT.get("cloudmap_service_name") or ""


def _delete_ecs_service(ecs, errors: list[str]) -> tuple[list[str], str | None]:
    """Returns (registry_arns, task_def_arn) for downstream cleanup."""
    if not CLUSTER_NAME or not CHOSEN_SERVICE_NAME:
        return [], None
    try:
        resp = ecs.describe_services(
            cluster=CLUSTER_NAME, services=[CHOSEN_SERVICE_NAME]
        )
    except ClientError as e:
        errors.append(f"describe service: {e}")
        return [], None
    services = resp.get("services") or []
    if not services:
        return [], None
    svc = services[0]
    registries = [
        r.get("registryArn")
        for r in (svc.get("serviceRegistries") or [])
        if r.get("registryArn")
    ]
    task_def = svc.get("taskDefinition")

    try:
        ecs.update_service(
            cluster=CLUSTER_NAME, service=CHOSEN_SERVICE_NAME, desiredCount=0
        )
    except ClientError as e:
        errors.append(f"scale-to-zero: {e}")
    try:
        ecs.delete_service(
            cluster=CLUSTER_NAME, service=CHOSEN_SERVICE_NAME, force=True
        )
    except ClientError as e:
        errors.append(f"delete service: {e}")
    return registries, task_def


def _deregister_task_definition(ecs, task_def: str | None, errors: list[str]) -> None:
    if not task_def:
        return
    try:
        ecs.deregister_task_definition(taskDefinition=task_def)
    except ClientError as e:
        errors.append(f"deregister task def: {e}")


def _delete_cloudmap_service(sd, service_id: str, errors: list[str]) -> None:
    """Deregister a Cloud Map service's instances, then delete the service.

    DeleteService fails while any instance is still registered, so instances are
    deregistered first. Best-effort: errors print to stderr.
    """
    try:
        instances = sd.list_instances(ServiceId=service_id).get("Instances") or []
        for inst in instances:
            try:
                sd.deregister_instance(ServiceId=service_id, InstanceId=inst.get("Id"))
            except ClientError as e:
                errors.append(f"deregister instance: {e}")
    except ClientError as e:
        errors.append(f"list_instances: {e}")

    # Cloud Map sometimes lags after instance deregistration; brief wait.
    time.sleep(2)
    try:
        sd.delete_service(Id=service_id)
    except ClientError as e:
        errors.append(f"delete cloudmap service {service_id}: {e}")


def _delete_cloudmap(sd, registry_arns: list[str], errors: list[str]) -> None:
    """Delete each Cloud Map service the agent registered, then the namespace."""
    namespace_id: str | None = None
    for arn in registry_arns:
        if ":service/" not in arn:
            continue
        service_id = arn.rsplit("/", 1)[-1]
        try:
            sd_svc = sd.get_service(Id=service_id).get("Service") or {}
            namespace_id = sd_svc.get("NamespaceId") or namespace_id
        except ClientError as e:
            errors.append(f"get_service {service_id}: {e}")

        _delete_cloudmap_service(sd, service_id, errors)

    # Find namespace by name if we don't have the id yet.
    if namespace_id is None and CHOSEN_NAMESPACE_NAME:
        try:
            paginator = sd.get_paginator("list_namespaces")
            for page in paginator.paginate():
                for ns in page.get("Namespaces") or []:
                    if ns.get("Name") == CHOSEN_NAMESPACE_NAME:
                        namespace_id = ns.get("Id")
                        break
                if namespace_id:
                    break
        except ClientError as e:
            errors.append(f"list_namespaces: {e}")

    if namespace_id:
        try:
            sd.delete_namespace(Id=namespace_id)
        except ClientError as e:
            errors.append(f"delete namespace {namespace_id}: {e}")


def _sweep_orphan_namespaces(sd, errors: list[str]) -> None:
    """Reap agent-created Cloud Map namespaces left with no ECS service to follow.

    When reset has no serviceRegistries to follow -- in the scenario-reset
    context there is no ``/logs/agent/agent-output.json`` to name the agent's
    service, so ``CHOSEN_NAMESPACE_NAME`` is empty too -- a Cloud Map namespace
    the agent created can linger and re-contaminate the account. The scenario's
    CloudFormation baseline creates no Cloud Map namespace of any type, so every
    namespace in the account is agent residue and safe to delete, regardless of
    type (HTTP, DNS_PRIVATE, or DNS_PUBLIC -- the task permits any).

    A namespace cannot be deleted while it still holds services, and ECS service
    deletion deregisters the Cloud Map instance but leaves the service, so each
    namespace's services are torn down first.

    Best-effort: errors print to stderr.
    """
    try:
        namespace_ids = [
            ns["Id"]
            for page in sd.get_paginator("list_namespaces").paginate()
            for ns in (page.get("Namespaces") or [])
            if ns.get("Id")
        ]
    except ClientError as e:
        errors.append(f"list_namespaces (orphan sweep): {e}")
        return

    for namespace_id in namespace_ids:
        try:
            service_ids = [
                svc["Id"]
                for page in sd.get_paginator("list_services").paginate(
                    Filters=[
                        {
                            "Name": "NAMESPACE_ID",
                            "Values": [namespace_id],
                            "Condition": "EQ",
                        }
                    ]
                )
                for svc in (page.get("Services") or [])
                if svc.get("Id")
            ]
        except ClientError as e:
            errors.append(f"list_services ({namespace_id}): {e}")
            service_ids = []

        for service_id in service_ids:
            _delete_cloudmap_service(sd, service_id, errors)

        try:
            sd.delete_namespace(Id=namespace_id)
        except ClientError as e:
            errors.append(f"delete orphan namespace {namespace_id}: {e}")


def main() -> int:
    ecs = boto3.client("ecs", region_name=REGION)
    sd = boto3.client("servicediscovery", region_name=REGION)
    errors: list[str] = []

    registries, task_def = _delete_ecs_service(ecs, errors)
    _deregister_task_definition(ecs, task_def, errors)
    _delete_cloudmap(sd, registries, errors)

    # No serviceRegistries were resolved to follow -- in the scenario-reset
    # context there is no agent-output.json to name the agent's ECS service, so
    # the targeted teardown above could not reach a namespace. Sweep any
    # agent-created Cloud Map namespace left behind.
    if CLUSTER_NAME and not registries:
        _sweep_orphan_namespaces(sd, errors)

    for err in errors:
        print(err, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
