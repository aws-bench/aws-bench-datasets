"""Reverse the agent's mutations and restore the broken baseline.

Puts the checkout-api repository, the canary pipeline and the ECS service back
into the stalled state so the next trial starts from an identical baseline.
Best effort: never raises.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import boto3
from botocore.exceptions import ClientError, ParamValidationError

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")

CLUSTER_NAME = os.environ.get("CLUSTER_NAME", "checkout-platform")
SERVICE_NAME = os.environ.get("SERVICE_NAME", "checkout-api-svc")
REPO_NAME = os.environ.get("REPO_NAME", "platform/checkout-api")
TASK_FAMILY = os.environ.get("TASK_FAMILY", "checkout-api")
CONTAINER_NAME = "checkout-api"
CANARY_PROJECT = os.environ.get("CANARY_PROJECT_NAME", "checkout-api-canary-build")
EXTRA_TAG_PARAM = os.environ.get(
    "EXTRA_TAG_PARAM", "/platform/checkout-api/canary/extra-tag"
)
REGISTRY_TABLE = os.environ.get("REGISTRY_TABLE_NAME", "checkout-release-registry")
AUDIT_FUNCTION = os.environ.get("AUDIT_FUNCTION_NAME", "checkout-image-audit")
PROBE_FUNCTION = os.environ.get("PROBE_FUNCTION_NAME", "checkout-synthetic-probe")
AUDIT_ALARM = os.environ.get("AUDIT_ALARM_NAME", "checkout-api-image-audit-errors")
BATCH_RUNNER_ROLE = "checkout-api-batch-runner"
CONTAINER_PORT = 8080

# SSM parameter that records the ARNs of the currently ACTIVE poisoned task
# definitions (revisions whose image reference points at the expired digest).
POISONED_REVISION_PARAM = os.environ.get(
    "POISONED_REVISION_PARAM", "/platform/ecs/poisoned-revision-arns"
)

# Baseline deployment configuration for the checkout-api service. The circuit
# breaker is off by design.
BASELINE_DEPLOYMENT_CONFIGURATION = {
    "deploymentCircuitBreaker": {"enable": False, "rollback": False},
    "minimumHealthyPercent": 100,
    "maximumPercent": 200,
}

# Prefixes that identify agent-added lifecycle-tracking tags (e.g.
# ``deployed-<digest>``, ``pin-<sha>``). Stripped between trials.
AGENT_TAG_PREFIXES = ("deployed-", "pin-")

BASELINE_LIFECYCLE_POLICY = {
    "rules": [
        {
            "rulePriority": 10,
            "description": "expire untagged images after 1 day to control storage cost",
            "selection": {
                "tagStatus": "untagged",
                "countType": "sinceImagePushed",
                "countUnit": "days",
                "countNumber": 1,
            },
            "action": {"type": "expire"},
        }
    ]
}

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


# ----------------------------------------------------------------------------
# baseline canary pipeline definition (must stay functionally identical to CDK)
# ----------------------------------------------------------------------------
def baseline_canary_buildspec() -> str:
    return json.dumps(
        {
            "version": "0.2",
            "phases": {
                "pre_build": {
                    "commands": [
                        'echo "canary refresh build $CODEBUILD_BUILD_ID canary_tag=$CANARY_TAG extra_tag=$EXTRA_TAG"',
                        "aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $REGISTRY_HOST",
                    ]
                },
                "build": {
                    "commands": [
                        "echo 'FROM public.ecr.aws/docker/library/busybox:1.36' > Dockerfile",
                        "echo 'ARG BUILD_STAMP=local' >> Dockerfile",
                        'echo \'RUN mkdir -p /www && echo ok > /www/health && echo "checkout-api canary build ${BUILD_STAMP}" > /www/index.html && echo "${BUILD_STAMP}" > /www/build.txt\' >> Dockerfile',
                        f"echo 'EXPOSE {CONTAINER_PORT}' >> Dockerfile",
                        'echo \'CMD ["httpd","-f","-v","-p","%d","-h","/www"]\' >> Dockerfile'
                        % CONTAINER_PORT,
                        'docker build --build-arg BUILD_STAMP="$CODEBUILD_BUILD_ID" -t $REPO_URI:$CANARY_TAG .',
                        "docker push $REPO_URI:$CANARY_TAG",
                        'if [ -n "$EXTRA_TAG" ]; then echo "publishing extra tag $EXTRA_TAG"; docker tag $REPO_URI:$CANARY_TAG $REPO_URI:$EXTRA_TAG; docker push $REPO_URI:$EXTRA_TAG; fi',
                    ]
                },
                "post_build": {
                    "commands": [
                        'DIGEST=$(aws ecr describe-images --repository-name $REPO_NAME --image-ids imageTag=$CANARY_TAG --query "imageDetails[0].imageDigest" --output text)',
                        'aws dynamodb put-item --table-name $REGISTRY_TABLE --item "{\\"pk\\":{\\"S\\":\\"channel:C71B\\"},\\"sk\\":{\\"S\\":\\"$CODEBUILD_BUILD_ID\\"},\\"imageDigest\\":{\\"S\\":\\"$DIGEST\\"},\\"canaryTag\\":{\\"S\\":\\"$CANARY_TAG\\"},\\"extraTag\\":{\\"S\\":\\"$EXTRA_TAG\\"},\\"repository\\":{\\"S\\":\\"$REPO_NAME\\"}}"',
                    ]
                },
            },
        },
        indent=2,
    )


def baseline_canary_environment(account: str, region: str) -> Dict[str, Any]:
    registry_host = f"{account}.dkr.ecr.{region}.amazonaws.com"
    return {
        "type": "LINUX_CONTAINER",
        "image": "aws/codebuild/standard:7.0",
        "computeType": "BUILD_GENERAL1_SMALL",
        "privilegedMode": True,
        "imagePullCredentialsType": "CODEBUILD",
        "environmentVariables": [
            {"name": "REGISTRY_HOST", "value": registry_host, "type": "PLAINTEXT"},
            {
                "name": "REPO_URI",
                "value": f"{registry_host}/{REPO_NAME}",
                "type": "PLAINTEXT",
            },
            {"name": "REPO_NAME", "value": REPO_NAME, "type": "PLAINTEXT"},
            {"name": "REGISTRY_TABLE", "value": REGISTRY_TABLE, "type": "PLAINTEXT"},
            {"name": "CANARY_TAG", "value": "latest", "type": "PLAINTEXT"},
            {"name": "EXTRA_TAG", "value": EXTRA_TAG_PARAM, "type": "PARAMETER_STORE"},
        ],
    }


# ----------------------------------------------------------------------------
# small ECR / ECS helpers
# ----------------------------------------------------------------------------
def image_digest(ecr, repo: str, tag: str) -> Optional[str]:
    try:
        details = ecr.describe_images(
            repositoryName=repo, imageIds=[{"imageTag": tag}]
        )["imageDetails"]
    except ClientError:
        return None
    return details[0]["imageDigest"] if details else None


def digest_exists(ecr, repo: str, digest: str) -> bool:
    try:
        ecr.describe_images(repositoryName=repo, imageIds=[{"imageDigest": digest}])
        return True
    except ClientError:
        return False


def register_variant(ecs, base_arn: str, image: str) -> str:
    base = ecs.describe_task_definition(taskDefinition=base_arn)["taskDefinition"]
    kwargs: Dict[str, Any] = {}
    for key in TD_COPY_KEYS:
        if key in base and base[key] not in (None, [], {}):
            kwargs[key] = base[key]
    for cdef in kwargs["containerDefinitions"]:
        if cdef["name"] == CONTAINER_NAME:
            cdef["image"] = image
    arn = ecs.register_task_definition(**kwargs)["taskDefinition"]["taskDefinitionArn"]
    print(f"[post] registered {arn} image={image}")
    return arn


def find_revision_with_image(ecs, family: str, image_suffix: str) -> Optional[str]:
    paginator = ecs.get_paginator("list_task_definitions")
    arns: List[str] = []
    for page in paginator.paginate(familyPrefix=family, status="ACTIVE", sort="DESC"):
        arns.extend(page["taskDefinitionArns"])
    for arn in arns[:25]:
        td = ecs.describe_task_definition(taskDefinition=arn)["taskDefinition"]
        for cdef in td["containerDefinitions"]:
            if cdef["name"] == CONTAINER_NAME and cdef["image"].endswith(image_suffix):
                return arn
    return None


def service_state(ecs, cluster: str, service: str) -> Dict[str, Any]:
    return ecs.describe_services(cluster=cluster, services=[service])["services"][0]


PULL_FAILURE_MARKERS = (
    "cannotpull",
    "unable to pull",
    "resourceinitializationerror",
    "unable to consistently start tasks",
    "image not found",
)


def pull_failure_visible(ecs, svc: Dict[str, Any]) -> bool:
    primary = next(
        (d for d in svc.get("deployments", []) if d["status"] == "PRIMARY"), None
    )
    if primary and primary.get("failedTasks", 0) >= 1:
        return True
    events = " | ".join(e["message"] for e in svc.get("events", [])[:20]).lower()
    if any(marker in events for marker in PULL_FAILURE_MARKERS):
        return True
    arns = ecs.list_tasks(
        cluster=CLUSTER_NAME, serviceName=SERVICE_NAME, desiredStatus="STOPPED"
    ).get("taskArns", [])
    if arns:
        for task in ecs.describe_tasks(cluster=CLUSTER_NAME, tasks=arns[:10])["tasks"]:
            reason = " ".join(
                [task.get("stoppedReason") or ""]
                + [c.get("reason") or "" for c in task.get("containers", [])]
            ).lower()
            if any(marker in reason for marker in PULL_FAILURE_MARKERS):
                return True
    return False


# ----------------------------------------------------------------------------
# reset the environment to the broken baseline
# ----------------------------------------------------------------------------
def reset_repository_controls(
    session: boto3.Session, region: str, account: str
) -> None:
    ecr = session.client("ecr", region_name=region)
    ssm = session.client("ssm", region_name=region)
    cb = session.client("codebuild", region_name=region)

    try:
        ecr.put_image_tag_mutability(
            repositoryName=REPO_NAME,
            imageTagMutability="MUTABLE",
            imageTagMutabilityExclusionFilters=[],
        )
    except (ParamValidationError, ClientError) as exc:
        print(f"[post] retrying mutability reset without exclusion filters ({exc})")
        ecr.put_image_tag_mutability(
            repositoryName=REPO_NAME, imageTagMutability="MUTABLE"
        )

    current = ecr.describe_repositories(repositoryNames=[REPO_NAME])["repositories"][0]
    if current.get("imageTagMutability") != "MUTABLE":
        raise RuntimeError(
            "could not restore mutable release tags on %s (now %s)"
            % (REPO_NAME, current.get("imageTagMutability"))
        )

    ecr.put_lifecycle_policy(
        repositoryName=REPO_NAME,
        lifecyclePolicyText=json.dumps(BASELINE_LIFECYCLE_POLICY),
    )

    ecr.set_repository_policy(
        repositoryName=REPO_NAME,
        policyText=json.dumps(
            {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Sid": "DenyBatchRunnerPulls",
                        "Effect": "Deny",
                        "Principal": {
                            "AWS": f"arn:aws:iam::{account}:role/{BATCH_RUNNER_ROLE}"
                        },
                        "Action": ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
                    }
                ],
            }
        ),
    )

    ssm.put_parameter(Name=EXTRA_TAG_PARAM, Value="v2.1", Type="String", Overwrite=True)

    cb.update_project(
        name=CANARY_PROJECT,
        source={"type": "NO_SOURCE", "buildspec": baseline_canary_buildspec()},
        environment=baseline_canary_environment(account, region),
    )
    print(
        "[post] repository controls, promote tag and canary pipeline reset to baseline"
    )


def ensure_release_tag(session: boto3.Session, region: str) -> None:
    """Make sure the release tag v2.1 still points at some image in the repo."""
    ecr = session.client("ecr", region_name=region)
    if image_digest(ecr, REPO_NAME, "v2.1"):
        return
    source = image_digest(ecr, REPO_NAME, "latest") or image_digest(
        ecr, REPO_NAME, "v2.0"
    )
    if not source:
        raise RuntimeError(f"{REPO_NAME} has no image to carry the release tag")
    manifest = ecr.batch_get_image(
        repositoryName=REPO_NAME,
        imageIds=[{"imageDigest": source}],
        acceptedMediaTypes=[
            "application/vnd.docker.distribution.manifest.v2+json",
            "application/vnd.oci.image.manifest.v1+json",
            "application/vnd.docker.distribution.manifest.list.v2+json",
            "application/vnd.oci.image.index.v1+json",
        ],
    )["images"][0]
    kwargs = {
        "repositoryName": REPO_NAME,
        "imageManifest": manifest["imageManifest"],
        "imageTag": "v2.1",
    }
    if manifest.get("imageManifestMediaType"):
        kwargs["imageManifestMediaType"] = manifest["imageManifestMediaType"]
    ecr.put_image(**kwargs)
    print(f"[post] restored release tag v2.1 onto {source}")


def expired_pinned_digest(session: boto3.Session, region: str) -> str:
    ddb = session.client("dynamodb", region_name=region)
    items = ddb.query(
        TableName=REGISTRY_TABLE,
        KeyConditionExpression="pk = :p",
        ExpressionAttributeValues={":p": {"S": "channel:F52A"}},
    ).get("Items", [])
    if not items:
        raise RuntimeError("release registry has no pinned deployment rows")
    items.sort(key=lambda i: i.get("registeredAt", {}).get("S", "0"))
    digest = items[-1]["imageDigest"]["S"]
    ecr = session.client("ecr", region_name=region)
    if digest_exists(ecr, REPO_NAME, digest):
        ecr.batch_delete_image(
            repositoryName=REPO_NAME, imageIds=[{"imageDigest": digest}]
        )
        deadline = time.time() + 120
        while time.time() < deadline and digest_exists(ecr, REPO_NAME, digest):
            time.sleep(5)
    return digest


def baseline_revision_for_image(
    ecs, family: str, image: str, scan_limit: int = 200
) -> Optional[str]:
    """Oldest ACTIVE revision in the family whose container runs ``image``.

    The release build stamps the build id into the image, so each setup produces a
    fresh v2.0 digest and only revisions from the current setup can match. A solved
    trial can add a second match by pinning the same digest; taking the oldest skips
    it and lands on the one setup registered, which is the one the baseline snapshot
    records. Mirrors scenarios/remediation-multiservice/scenario/setup/
    setup_checkout_delivery_hp473c290.py::baseline_revision_for_image.

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
            td = ecs.describe_task_definition(taskDefinition=arn)["taskDefinition"]
            for cdef in td["containerDefinitions"]:
                if cdef["name"] == CONTAINER_NAME and cdef.get("image") == image:
                    return arn
    return None


def ensure_healthy_predecessor(
    session: boto3.Session, region: str, account: str
) -> str:
    """Roll the service back onto the revision the scenario baseline holds.

    The target is the revision setup would pick, not merely any healthy one: a
    solved trial leaves the service running the agent's own revision, which would
    keep the service's TaskDefinition away from baseline.
    """
    ecs = session.client("ecs", region_name=region)
    ecr = session.client("ecr", region_name=region)
    repo_uri = f"{account}.dkr.ecr.{region}.amazonaws.com/{REPO_NAME}"

    svc = service_state(ecs, CLUSTER_NAME, SERVICE_NAME)
    primary = next((d for d in svc["deployments"] if d["status"] == "PRIMARY"), None)

    digest = image_digest(ecr, REPO_NAME, "v2.0") or image_digest(
        ecr, REPO_NAME, "latest"
    )
    if not digest:
        raise RuntimeError(
            f"{REPO_NAME} has no usable image for the predecessor revision"
        )
    image = f"{repo_uri}@{digest}"
    arn = baseline_revision_for_image(ecs, TASK_FAMILY, image)
    if not arn:
        arn = register_variant(ecs, svc["taskDefinition"], image)

    if (
        primary
        and primary["taskDefinition"] == arn
        and svc["runningCount"] >= 2
        and svc["desiredCount"] == 2
        and primary.get("rolloutState") in (None, "COMPLETED")
    ):
        print(f"[post] service already on the baseline revision {arn}")
        return arn

    ecs.update_service(
        cluster=CLUSTER_NAME, service=SERVICE_NAME, taskDefinition=arn, desiredCount=2
    )
    print(f"[post] rolling the baseline revision {arn} out first")
    ecs.get_waiter("services_stable").wait(
        cluster=CLUSTER_NAME,
        services=[SERVICE_NAME],
        WaiterConfig={"Delay": 15, "MaxAttempts": 60},
    )
    return arn


def record_poisoned_revisions(
    session: boto3.Session, region: str, arns: List[str]
) -> None:
    """Overwrite the SSM parameter recording the poisoned revision ARNs.

    Only currently ACTIVE revisions belong here. ECS has no un-deregister API,
    so a revision left INACTIVE stays INACTIVE.
    """
    if not arns:
        return
    ssm = session.client("ssm", region_name=region)
    try:
        ssm.put_parameter(
            Name=POISONED_REVISION_PARAM,
            Value=json.dumps(arns),
            Type="String",
            Overwrite=True,
        )
        print(f"[post] recorded poisoned revisions {arns} in {POISONED_REVISION_PARAM}")
    except ClientError as exc:
        print(f"[post] failed to record poisoned revisions: {exc}")


def reset_service_deployment_configuration(session: boto3.Session, region: str) -> None:
    """Restore the service to the baseline deployment configuration."""
    ecs = session.client("ecs", region_name=region)
    try:
        ecs.update_service(
            cluster=CLUSTER_NAME,
            service=SERVICE_NAME,
            deploymentConfiguration=BASELINE_DEPLOYMENT_CONFIGURATION,
        )
        print("[post] service deployment configuration reset to baseline")
    except ClientError as exc:
        print(f"[post] failed to reset deployment configuration: {exc}")


def strip_agent_added_tags(session: boto3.Session, region: str) -> None:
    """Delete lifecycle-tracking tags added by the agent (``deployed-*``, ``pin-*``)."""
    ecr = session.client("ecr", region_name=region)
    try:
        images = ecr.list_images(
            repositoryName=REPO_NAME, filter={"tagStatus": "TAGGED"}
        )
    except ClientError as exc:
        print(f"[post] could not list images to strip agent tags: {exc}")
        return
    for img in images.get("imageIds", []):
        tag = img.get("imageTag", "")
        if not any(tag.startswith(p) for p in AGENT_TAG_PREFIXES):
            continue
        try:
            ecr.batch_delete_image(
                repositoryName=REPO_NAME, imageIds=[{"imageTag": tag}]
            )
            print(f"[post] stripped agent tag {tag}")
        except ClientError as exc:
            print(f"[post] failed to strip agent tag {tag}: {exc}")


def reset_stalled_rollout(session: boto3.Session, region: str, account: str) -> None:
    ecs = session.client("ecs", region_name=region)
    repo_uri = f"{account}.dkr.ecr.{region}.amazonaws.com/{REPO_NAME}"
    digest = expired_pinned_digest(session, region)
    broken_image = f"{repo_uri}@{digest}"

    svc = service_state(ecs, CLUSTER_NAME, SERVICE_NAME)
    primary = next((d for d in svc["deployments"] if d["status"] == "PRIMARY"), None)
    already_broken = (
        primary is not None
        and len(svc["deployments"]) >= 2
        and svc["runningCount"] >= 2
        and svc["desiredCount"] == 2
        and pull_failure_visible(ecs, svc)
    )
    if already_broken:
        td = ecs.describe_task_definition(taskDefinition=primary["taskDefinition"])[
            "taskDefinition"
        ]
        image = next(
            c["image"]
            for c in td["containerDefinitions"]
            if c["name"] == CONTAINER_NAME
        )
        if image == broken_image:
            print("[post] service is already stalled on the expired digest")
            record_poisoned_revisions(session, region, [primary["taskDefinition"]])
            return

    ensure_healthy_predecessor(session, region, account)

    broken_arn = find_revision_with_image(ecs, TASK_FAMILY, f"@{digest}")
    if not broken_arn:
        svc = service_state(ecs, CLUSTER_NAME, SERVICE_NAME)
        broken_arn = register_variant(ecs, svc["taskDefinition"], broken_image)
    ecs.update_service(
        cluster=CLUSTER_NAME,
        service=SERVICE_NAME,
        taskDefinition=broken_arn,
        desiredCount=2,
    )
    print(f"[post] rolling out {broken_arn} (pinned to the expired digest)")

    deadline = time.time() + 480
    while time.time() < deadline:
        svc = service_state(ecs, CLUSTER_NAME, SERVICE_NAME)
        if (
            len(svc["deployments"]) >= 2
            and pull_failure_visible(ecs, svc)
            and svc["runningCount"] >= 2
        ):
            print("[post] stalled rollout reproduced")
            record_poisoned_revisions(session, region, [broken_arn])
            return
        time.sleep(20)
    raise RuntimeError("timed out reproducing the stalled rollout")


def run(session: Optional[boto3.Session] = None, region: str = REGION, **kwargs):
    if session is None:
        session = boto3.Session(region_name=region)
    try:
        account = session.client("sts", region_name=region).get_caller_identity()[
            "Account"
        ]
    except Exception as exc:
        print(f"[post] unable to resolve account: {exc}")
        return

    for label, fn in (
        (
            "repository controls",
            lambda: reset_repository_controls(session, region, account),
        ),
        ("release tag", lambda: ensure_release_tag(session, region)),
        # Undo agent hardening BEFORE re-priming the stalled rollout so the
        # cleanup does not touch the fresh broken revision we register next.
        (
            "service deployment config",
            lambda: reset_service_deployment_configuration(session, region),
        ),
        ("agent-added tags", lambda: strip_agent_added_tags(session, region)),
        ("stalled rollout", lambda: reset_stalled_rollout(session, region, account)),
    ):
        try:
            fn()
        except Exception as exc:
            print(f"[post] {label} reset failed: {exc}")

    print("[post] baseline restore attempted")


if __name__ == "__main__":
    run()
