"""Post-deploy seeding for the checkout-api delivery incident.

Runs the real build pipelines to publish images, brings checkout-api up on the
v2.0 release, then reproduces the production sequence that stalled the v2.1
rollout:

    release build v2.1  -> digest B, task definition pinned to digest B
    canary build        -> moves `latest` AND the release tag `v2.1` onto its
                           own image (digest C), leaving digest B untagged
    untagged expiry     -> digest B is removed from the repository
    service update      -> replacement tasks can no longer pull digest B

The previously deployed v2.0 tasks keep serving traffic behind the internal ALB.
"""

from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Optional

import boto3

REGION = "us-east-1"
ENV_ID = "remediation-multiservice"
PLATFORM_STACK = f"{ENV_ID}-Platform-k0wms2i88-{REGION}"
DELIVERY_STACK = f"{ENV_ID}-EcsDelivery-hp473c290-{REGION}"
PIPELINES_STACK = f"{ENV_ID}-Pipelines-p1gtxzog5-{REGION}"

# Records the ACTIVE task-definition ARNs whose image reference points at the
# expired digest.
POISONED_REVISION_PARAM = "/platform/ecs/poisoned-revision-arns"

BUILD_DEADLINE = 1500
TD_COPY_KEYS = [
    "family",
    "taskRoleArn",
    "executionRoleArn",
    "networkMode",
    "containerDefinitions",
    "volumes",
    "placementConstraints",
    "requiresCompatibilities",
    "cpu",
    "memory",
    "runtimePlatform",
    "ephemeralStorage",
    "pidMode",
    "ipcMode",
    "proxyConfiguration",
]


def stack_outputs(cfn, stack_name: str) -> Dict[str, str]:
    desc = cfn.describe_stacks(StackName=stack_name)["Stacks"][0]
    return {o["OutputKey"]: o["OutputValue"] for o in desc.get("Outputs", [])}


def run_build(
    cb, project: str, overrides: Optional[List[Dict[str, str]]] = None
) -> Dict[str, Any]:
    kwargs: Dict[str, Any] = {"projectName": project}
    if overrides:
        kwargs["environmentVariablesOverride"] = [
            {"name": k, "value": v, "type": "PLAINTEXT"}
            for item in overrides
            for k, v in item.items()
        ]
    build_id = cb.start_build(**kwargs)["build"]["id"]
    print(f"[setup] started {project} build {build_id}")
    deadline = time.time() + BUILD_DEADLINE
    while time.time() < deadline:
        build = cb.batch_get_builds(ids=[build_id])["builds"][0]
        if build.get("buildComplete"):
            status = build.get("buildStatus")
            print(f"[setup] {project} build {build_id} finished with {status}")
            if status != "SUCCEEDED":
                raise RuntimeError(f"{project} build {build_id} ended in {status}")
            return build
        time.sleep(15)
    raise RuntimeError(f"{project} build {build_id} did not finish in time")


def image_digest(ecr, repo: str, tag: str) -> Optional[str]:
    try:
        details = ecr.describe_images(
            repositoryName=repo, imageIds=[{"imageTag": tag}]
        )["imageDetails"]
    except ecr.exceptions.ImageNotFoundException:
        return None
    return details[0]["imageDigest"] if details else None


def digest_exists(ecr, repo: str, digest: str) -> bool:
    try:
        ecr.describe_images(repositoryName=repo, imageIds=[{"imageDigest": digest}])
        return True
    except ecr.exceptions.ImageNotFoundException:
        return False


def digest_tags(ecr, repo: str, digest: str) -> List[str]:
    try:
        details = ecr.describe_images(
            repositoryName=repo, imageIds=[{"imageDigest": digest}]
        )["imageDetails"]
    except ecr.exceptions.ImageNotFoundException:
        return []
    return details[0].get("imageTags", []) if details else []


def container_image(ecs, task_def_arn: str, container: str) -> str:
    """Image reference the named container runs in this task definition, or "" if absent."""
    task_def = ecs.describe_task_definition(taskDefinition=task_def_arn)[
        "taskDefinition"
    ]
    for cdef in task_def["containerDefinitions"]:
        if cdef["name"] == container:
            return cdef.get("image", "")
    return ""


def task_definition_family(task_def_arn: str) -> str:
    """Family name out of a task definition arn (``.../checkout-api:8`` -> ``checkout-api``)."""
    return task_def_arn.rsplit("/", 1)[-1].rsplit(":", 1)[0]


def baseline_revision_for_image(
    ecs, family: str, image: str, container: str, scan_limit: int = 200
) -> Optional[str]:
    """Oldest ACTIVE revision in the family whose container runs ``image``.

    The release build stamps ``$CODEBUILD_BUILD_ID`` into the image, so each setup
    produces a fresh v2.0 digest and only revisions from this setup can match. A
    solved trial can add a second match by pinning the same digest; taking the
    oldest skips it and lands on the one this setup registered, which is the one
    the baseline snapshot records.

    ponytail: revisions from earlier setups stay ACTIVE and cost scan budget
    without ever matching; 200 covers ~100 runs. Deregister superseded revisions
    if a long-lived account ever exhausts it.
    """
    paginator = ecs.get_paginator("list_task_definitions")
    seen = 0
    for page in paginator.paginate(familyPrefix=family, status="ACTIVE", sort="ASC"):
        for arn in page["taskDefinitionArns"]:
            if seen >= scan_limit:
                return None
            seen += 1
            if container_image(ecs, arn, container) == image:
                return arn
    return None


def register_variant(ecs, base_arn: str, image: str, container: str) -> str:
    base = ecs.describe_task_definition(taskDefinition=base_arn)["taskDefinition"]
    kwargs: Dict[str, Any] = {}
    for key in TD_COPY_KEYS:
        if key in base and base[key] not in (None, [], {}):
            kwargs[key] = base[key]
    containers = kwargs["containerDefinitions"]
    for cdef in containers:
        if cdef["name"] == container:
            cdef["image"] = image
    arn = ecs.register_task_definition(**kwargs)["taskDefinition"]["taskDefinitionArn"]
    print(f"[setup] registered {arn} with image {image}")
    return arn


def wait_service_stable(ecs, cluster: str, service: str, attempts: int = 80) -> None:
    print(f"[setup] waiting for {service} to stabilise")
    ecs.get_waiter("services_stable").wait(
        cluster=cluster,
        services=[service],
        WaiterConfig={"Delay": 15, "MaxAttempts": attempts},
    )


PULL_FAILURE_MARKERS = (
    "cannotpull",
    "unable to pull",
    "resourceinitializationerror",
    "unable to consistently start tasks",
    "image not found",
)


def stall_evidence(ecs, cluster: str, service: str, svc: Dict[str, Any]) -> bool:
    """True once the failing replacement tasks are observable on the service."""
    primary = next(
        (d for d in svc.get("deployments", []) if d["status"] == "PRIMARY"), None
    )
    if primary and primary.get("failedTasks", 0) >= 1:
        return True
    events = " | ".join(e["message"] for e in svc.get("events", [])[:20]).lower()
    if any(marker in events for marker in PULL_FAILURE_MARKERS):
        return True
    arns = ecs.list_tasks(
        cluster=cluster, serviceName=service, desiredStatus="STOPPED"
    ).get("taskArns", [])
    if arns:
        for task in ecs.describe_tasks(cluster=cluster, tasks=arns[:10])["tasks"]:
            reason = " ".join(
                [task.get("stoppedReason") or ""]
                + [c.get("reason") or "" for c in task.get("containers", [])]
            ).lower()
            if any(marker in reason for marker in PULL_FAILURE_MARKERS):
                return True
    return False


def wait_for_stalled_rollout(
    ecs, cluster: str, service: str, broken_arn: str, deadline_s: int = 600
) -> None:
    """Block until the replacement tasks are visibly failing to pull their image."""
    deadline = time.time() + deadline_s
    while time.time() < deadline:
        svc = ecs.describe_services(cluster=cluster, services=[service])["services"][0]
        primary = [d for d in svc["deployments"] if d["status"] == "PRIMARY"]
        if (
            primary
            and primary[0]["taskDefinition"] == broken_arn
            and len(svc["deployments"]) >= 2
            and stall_evidence(ecs, cluster, service, svc)
        ):
            print("[setup] rollout is stalled on the missing image as expected")
            return
        time.sleep(20)
    raise RuntimeError("timed out waiting for the stalled rollout evidence to appear")


def run(session: Optional[boto3.Session] = None, region: str = REGION, **kwargs):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY")

    cfn = session.client("cloudformation", region_name=region)
    ecr = session.client("ecr", region_name=region)
    ecs = session.client("ecs", region_name=region)
    cb = session.client("codebuild", region_name=region)
    ddb = session.client("dynamodb", region_name=region)
    sts = session.client("sts", region_name=region)
    ssm = session.client("ssm", region_name=region)

    platform = stack_outputs(cfn, PLATFORM_STACK)
    delivery = stack_outputs(cfn, DELIVERY_STACK)
    pipelines = stack_outputs(cfn, PIPELINES_STACK)

    account = sts.get_caller_identity()["Account"]
    repo = delivery["CheckoutRepoName"]
    repo_uri = f"{account}.dkr.ecr.{region}.amazonaws.com/{repo}"
    cluster = delivery["ClusterName"]
    service = delivery["CheckoutServiceName"]
    container = "checkout-api"
    table = platform["ReleaseRegistryTableName"]
    release_project = pipelines["ReleaseProjectName"]
    canary_project = pipelines["CanaryProjectName"]

    # ------------------------------------------------------------------
    # 1. Publish the v2.0 release that is currently serving production.
    # ------------------------------------------------------------------
    run_build(cb, release_project, [{"RELEASE_TAG": "v2.0"}])
    digest_v20 = image_digest(ecr, repo, "v2.0")
    if not digest_v20:
        raise RuntimeError("v2.0 image is missing after the release build")
    print(f"[setup] v2.0 -> {digest_v20}")

    svc = ecs.describe_services(cluster=cluster, services=[service])["services"][0]
    # Pin the service to a revision running the just-built v2.0 digest, reusing the
    # oldest one that already carries it and registering only when none does.
    stable_image = f"{repo_uri}@{digest_v20}"
    family = task_definition_family(svc["taskDefinition"])
    stable_td = baseline_revision_for_image(ecs, family, stable_image, container)
    if stable_td:
        print(f"[setup] pinning to existing revision {stable_td}")
    else:
        stable_td = register_variant(
            ecs, svc["taskDefinition"], stable_image, container
        )

    if svc["taskDefinition"] != stable_td or svc["desiredCount"] != 2:
        ecs.update_service(
            cluster=cluster, service=service, taskDefinition=stable_td, desiredCount=2
        )

    # ------------------------------------------------------------------
    # 2. Publish the v2.1 release and pin a task definition to its digest.
    # ------------------------------------------------------------------
    run_build(cb, release_project, [{"RELEASE_TAG": "v2.1"}])
    digest_v21 = image_digest(ecr, repo, "v2.1")
    if not digest_v21:
        raise RuntimeError("v2.1 image is missing after the release build")
    print(f"[setup] v2.1 -> {digest_v21}")

    wait_service_stable(ecs, cluster, service)

    pinned_arn = register_variant(ecs, stable_td, f"{repo_uri}@{digest_v21}", container)
    try:
        ssm.put_parameter(
            Name=POISONED_REVISION_PARAM,
            Value=json.dumps([pinned_arn]),
            Type="String",
            Overwrite=True,
        )
        print(
            f"[setup] recorded poisoned revision {pinned_arn} in {POISONED_REVISION_PARAM}"
        )
    except Exception as exc:  # pragma: no cover
        print(f"[setup] failed to record poisoned revision: {exc}")
    ddb.put_item(
        TableName=table,
        Item={
            "pk": {"S": "channel:F52A"},
            "sk": {"S": pinned_arn},
            "repository": {"S": repo},
            "imageDigest": {"S": digest_v21},
            "releaseTag": {"S": "v2.1"},
            "pinnedBy": {"S": release_project},
            "registeredAt": {"S": str(int(time.time()))},
        },
    )
    # Maps opaque channel ids to their names.
    ddb.put_item(
        TableName=table,
        Item={
            "pk": {"S": "catalog"},
            "sk": {"S": "channels"},
            "channels": {
                "M": {
                    "channel:A34F": {"S": "release"},
                    "channel:C71B": {"S": "canary"},
                    "channel:D91E": {"S": "audit"},
                    "channel:F52A": {"S": "deploy"},
                }
            },
        },
    )

    # ------------------------------------------------------------------
    # 3. The scheduled canary refresh republishes `latest` *and* the release
    #    channel tag onto its own image, orphaning the pinned digest.
    # ------------------------------------------------------------------
    run_build(cb, canary_project)
    canary_digest = image_digest(ecr, repo, "latest")
    print(f"[setup] canary latest -> {canary_digest}")
    if canary_digest == digest_v21:
        raise RuntimeError("canary build did not produce a new image digest")

    deadline = time.time() + 120
    while time.time() < deadline and digest_tags(ecr, repo, digest_v21):
        time.sleep(10)
    remaining = digest_tags(ecr, repo, digest_v21)
    if remaining:
        raise RuntimeError(f"pinned digest still carries tags {remaining}")

    # ------------------------------------------------------------------
    # 4. The untagged-expiry lifecycle rule reaps the now untagged digest.
    # ------------------------------------------------------------------
    if digest_exists(ecr, repo, digest_v21):
        ecr.batch_delete_image(
            repositoryName=repo, imageIds=[{"imageDigest": digest_v21}]
        )
        print(f"[setup] untagged digest {digest_v21} expired out of {repo}")
    deadline = time.time() + 120
    while time.time() < deadline and digest_exists(ecr, repo, digest_v21):
        time.sleep(5)
    if digest_exists(ecr, repo, digest_v21):
        raise RuntimeError("expired digest is still present")

    # ------------------------------------------------------------------
    # 5. Roll the service onto the pinned revision - replacement tasks now
    #    fail to pull while the v2.0 tasks keep serving.
    # ------------------------------------------------------------------
    ecs.update_service(
        cluster=cluster, service=service, taskDefinition=pinned_arn, desiredCount=2
    )
    wait_for_stalled_rollout(ecs, cluster, service, pinned_arn)

    svc = ecs.describe_services(cluster=cluster, services=[service])["services"][0]
    print(
        "[setup] service state desired=%s running=%s pending=%s deployments=%s"
        % (
            svc["desiredCount"],
            svc["runningCount"],
            svc["pendingCount"],
            len(svc["deployments"]),
        )
    )
    if svc["runningCount"] < 2:
        raise RuntimeError("the previously deployed tasks are not serving traffic")


if __name__ == "__main__":
    run()
