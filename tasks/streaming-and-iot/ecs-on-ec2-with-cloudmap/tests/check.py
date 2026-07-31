"""Programmatic verifier for ecs-on-ec2-with-cloudmap.

Validates the agent created an ECS service on the precondition cluster
and registered it in AWS Cloud Map via `serviceRegistries`.

Per AWS docs:
  - https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_DescribeServices.html
  - https://docs.aws.amazon.com/cloud-map/latest/api/API_GetService.html
  - https://docs.aws.amazon.com/cloud-map/latest/api/API_GetNamespace.html
"""

import json
import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_REGION", "us-east-1")
CLUSTER_NAME = os.environ.get("CLUSTER_NAME", "")

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    AGENT_OUTPUT = {}

REQUIRED_OUTPUT_KEYS = ("service_name", "namespace_name", "cloudmap_service_name")
CHOSEN_SERVICE_NAME = AGENT_OUTPUT.get("service_name") or ""
CHOSEN_NAMESPACE_NAME = AGENT_OUTPUT.get("namespace_name") or ""
CHOSEN_CLOUDMAP_SERVICE_NAME = AGENT_OUTPUT.get("cloudmap_service_name") or ""


def _ecs():
    return boto3.client("ecs", region_name=REGION)


def _sd():
    return boto3.client("servicediscovery", region_name=REGION)


def _describe_service() -> dict | None:
    if not CLUSTER_NAME or not CHOSEN_SERVICE_NAME:
        return None
    try:
        resp = _ecs().describe_services(
            cluster=CLUSTER_NAME, services=[CHOSEN_SERVICE_NAME]
        )
    except ClientError:
        return None
    services = resp.get("services") or []
    if not services:
        return None
    return services[0]


def _find_namespace() -> dict | None:
    """Find the agent-reported namespace by name."""
    if not CHOSEN_NAMESPACE_NAME:
        return None
    try:
        paginator = _sd().get_paginator("list_namespaces")
        for page in paginator.paginate():
            for ns in page.get("Namespaces") or []:
                if ns.get("Name") == CHOSEN_NAMESPACE_NAME:
                    return ns
    except ClientError:
        return None
    return None


@criterion(description="agent wrote agent-output.json with all required keys")
def output_contract_followed(workspace: Path) -> bool:
    return bool(AGENT_OUTPUT) and all(k in AGENT_OUTPUT for k in REQUIRED_OUTPUT_KEYS)


@criterion(
    description="ECS service is ACTIVE on the precondition cluster with non-empty serviceRegistries"
)
def ecs_service_active_with_registry(workspace: Path) -> bool:
    svc = _describe_service()
    if svc is None:
        return False
    if svc.get("status") != "ACTIVE":
        return False
    registries = svc.get("serviceRegistries") or []
    return len(registries) > 0


@criterion(
    description="Cloud Map service from serviceRegistries lives in agent's namespace"
)
def cloudmap_service_in_namespace(workspace: Path) -> bool:
    """list_namespaces is eventually-consistent — a freshly-created
    namespace can be invisible for a few seconds. Retry up to ~30s.
    """
    svc = _describe_service()
    if svc is None:
        return False
    registries = svc.get("serviceRegistries") or []
    if not registries:
        return False

    import time as _t

    namespace = None
    for _ in range(6):  # ~30s with 5s sleep
        namespace = _find_namespace()
        if namespace is not None:
            break
        _t.sleep(5)
    if namespace is None:
        return False
    namespace_id = namespace.get("Id")
    if not namespace_id:
        return False

    sd = _sd()
    for reg in registries:
        arn = reg.get("registryArn") or ""
        # Cloud Map service ARN: arn:aws:servicediscovery:<region>:<acct>:service/srv-<id>
        if ":service/" not in arn:
            continue
        service_id = arn.rsplit("/", 1)[-1]
        if not service_id:
            continue
        try:
            sd_svc = sd.get_service(Id=service_id).get("Service") or {}
        except ClientError:
            continue
        if sd_svc.get("NamespaceId") == namespace_id:
            # Also confirm the agent-reported cloudmap_service_name matches.
            if sd_svc.get("Name") == CHOSEN_CLOUDMAP_SERVICE_NAME:
                return True
    return False


# End-to-end behavioral criteria: prove the service has actually
# launched a task and registered it, not just that the service object
# exists with a registry pointer.

ECS_RUNNING_POLL_SEC = 240
ECS_RUNNING_INTERVAL_SEC = 15


def _service_running_count() -> int | None:
    svc = _describe_service()
    if svc is None:
        return None
    return svc.get("runningCount", 0)


@criterion(
    description="ECS service has runningCount >= desiredCount within 4 min (proves a task actually launched on the cluster)"
)
def ecs_service_has_running_tasks(workspace: Path) -> bool:
    """Catches the case where the service is ACTIVE but stuck at
    runningCount=0 because of a misconfigured task definition,
    image-pull failures, missing capacity provider, etc. desiredCount=0
    is treated as failure (a service with no desired tasks is not a
    real deployment)."""
    elapsed = 0
    while elapsed <= ECS_RUNNING_POLL_SEC:
        svc = _describe_service()
        if svc is None:
            return False
        desired = svc.get("desiredCount", 0) or 0
        running = svc.get("runningCount", 0) or 0
        if desired > 0 and running >= desired:
            return True
        import time as _t

        _t.sleep(ECS_RUNNING_INTERVAL_SEC)
        elapsed += ECS_RUNNING_INTERVAL_SEC
    return False


# NOTE: We intentionally do not check `servicediscovery:ListInstances` for
# the Cloud Map service. The instruction asks for an HTTP namespace, and
# per AWS docs (https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-discovery.html
# and https://docs.aws.amazon.com/cloud-map/latest/api/API_DiscoverInstances.html)
# ECS only auto-registers task instances for DNS-based namespaces; HTTP
# namespaces require manual RegisterInstance calls. Asserting non-empty
# ListInstances would force the agent to bolt on a custom registration
# step that isn't part of the documented HTTP-namespace integration. The
# strongest available signal for an HTTP-namespace setup is the
# combination of `cloudmap_service_in_namespace` (correct wiring) and
# `ecs_service_has_running_tasks` (the service is actually live).


@criterion(
    description="ECS service uses EC2 launch type or ASG capacity provider (not Fargate)"
)
def ecs_service_uses_ec2(workspace: Path) -> bool:
    svc = _describe_service()
    if svc is None:
        return False
    # Check launch type
    if svc.get("launchType") == "EC2":
        return True
    # Check capacity provider strategy for ASG-based providers
    strategy = svc.get("capacityProviderStrategy") or []
    for entry in strategy:
        provider = (
            entry.get("capacityProvider") or entry.get("capacityProviderName") or ""
        )
        if provider and provider not in ("FARGATE", "FARGATE_SPOT"):
            return True
    return False
