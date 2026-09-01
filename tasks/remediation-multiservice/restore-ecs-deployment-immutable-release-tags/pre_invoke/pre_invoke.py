"""Trial setup for the stalled checkout-api rollout.

1. Resets the delivery plane to the broken baseline (mutable release tags,
   aggressive untagged expiry, canary republishing the release tag, and the
   checkout-api service rolling onto a task definition whose pinned image
   digest no longer exists).
2. Regenerates live observability: real traffic through the internal ALB from
   the in-VPC synthetic probe, and real ECR audit findings that drive the
   image-audit alarm into ALARM.
"""

from __future__ import annotations

import io
import json
import os
import time
import zipfile
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
    print(f"[pre] registered {arn} image={image}")
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
        print(f"[pre] retrying mutability reset without exclusion filters ({exc})")
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
        "[pre] repository controls, promote tag and canary pipeline reset to baseline"
    )


def _run_canary_build_sync(session: boto3.Session, region: str) -> None:
    """Trigger the canary CodeBuild project and wait for it to publish an image.

    The canary project's buildspec pushes a fresh busybox-based image to
    ``$REPO_URI:latest`` and records its digest to the registry table. It is
    the reseed mechanism when the ECR repo has been drained.
    """
    cb = session.client("codebuild", region_name=region)
    build = cb.start_build(projectName=CANARY_PROJECT)["build"]
    build_id = build["id"]
    print(f"[pre] canary reseed build started id={build_id}")
    deadline = time.time() + 600  # 10 min ceiling
    while time.time() < deadline:
        info = cb.batch_get_builds(ids=[build_id])["builds"][0]
        status = info.get("buildStatus")
        if status == "SUCCEEDED":
            print(f"[pre] canary reseed complete id={build_id}")
            return
        if status in ("FAILED", "STOPPED", "TIMED_OUT", "FAULT"):
            raise RuntimeError(
                f"canary reseed build ended in status={status} id={build_id}"
            )
        time.sleep(15)
    raise RuntimeError(f"canary reseed build did not finish within 600s id={build_id}")


def ensure_release_tag(session: boto3.Session, region: str) -> None:
    """Make sure the release tag v2.1 still points at some image in the repo."""
    ecr = session.client("ecr", region_name=region)
    if image_digest(ecr, REPO_NAME, "v2.1"):
        return
    source = image_digest(ecr, REPO_NAME, "latest") or image_digest(
        ecr, REPO_NAME, "v2.0"
    )
    if not source:
        # Repo has been drained by a prior trial. Reseed via the canary
        # pipeline — that's what it's for — then reread `latest`. The
        # canary buildspec also publishes the ``$EXTRA_TAG`` (v2.1) alongside
        # ``latest``, so v2.1 may already exist post-reseed; short-circuit
        # if so to avoid the ImageAlreadyExistsException on the put_image
        # retag below.
        print(f"[pre] {REPO_NAME} has no seed image; kicking canary to reseed 'latest'")
        _run_canary_build_sync(session, region)
        if image_digest(ecr, REPO_NAME, "v2.1"):
            print("[pre] canary reseed already carried v2.1 forward")
            return
        source = image_digest(ecr, REPO_NAME, "latest")
        if not source:
            raise RuntimeError(f"{REPO_NAME} still has no image after canary reseed")
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
    print(f"[pre] restored release tag v2.1 onto {source}")


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


def ensure_healthy_predecessor(
    session: boto3.Session, region: str, account: str
) -> str:
    ecs = session.client("ecs", region_name=region)
    ecr = session.client("ecr", region_name=region)
    repo_uri = f"{account}.dkr.ecr.{region}.amazonaws.com/{REPO_NAME}"

    svc = service_state(ecs, CLUSTER_NAME, SERVICE_NAME)
    primary = next((d for d in svc["deployments"] if d["status"] == "PRIMARY"), None)
    if primary and svc["runningCount"] >= 2 and svc["desiredCount"] == 2:
        td = ecs.describe_task_definition(taskDefinition=primary["taskDefinition"])[
            "taskDefinition"
        ]
        image = next(
            c["image"]
            for c in td["containerDefinitions"]
            if c["name"] == CONTAINER_NAME
        )
        resolvable = True
        if "@sha256:" in image:
            resolvable = digest_exists(ecr, REPO_NAME, image.split("@", 1)[1])
        if resolvable and primary.get("rolloutState") in (None, "COMPLETED"):
            print(f"[pre] keeping healthy predecessor {primary['taskDefinition']}")
            return primary["taskDefinition"]

    digest = image_digest(ecr, REPO_NAME, "v2.0") or image_digest(
        ecr, REPO_NAME, "latest"
    )
    if not digest:
        raise RuntimeError(
            f"{REPO_NAME} has no usable image for the predecessor revision"
        )
    image = f"{repo_uri}@{digest}"
    arn = find_revision_with_image(ecs, TASK_FAMILY, f"@{digest}")
    if not arn:
        arn = register_variant(ecs, svc["taskDefinition"], image)
    ecs.update_service(
        cluster=CLUSTER_NAME, service=SERVICE_NAME, taskDefinition=arn, desiredCount=2
    )
    print(f"[pre] rolling the healthy predecessor {arn} out first")
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
        print(f"[pre] recorded poisoned revisions {arns} in {POISONED_REVISION_PARAM}")
    except ClientError as exc:
        print(f"[pre] failed to record poisoned revisions: {exc}")


def reset_service_deployment_configuration(session: boto3.Session, region: str) -> None:
    """Restore the service to the baseline deployment configuration."""
    ecs = session.client("ecs", region_name=region)
    try:
        ecs.update_service(
            cluster=CLUSTER_NAME,
            service=SERVICE_NAME,
            deploymentConfiguration=BASELINE_DEPLOYMENT_CONFIGURATION,
        )
        print("[pre] service deployment configuration reset to baseline")
    except ClientError as exc:
        print(f"[pre] failed to reset deployment configuration: {exc}")


def strip_agent_added_tags(session: boto3.Session, region: str) -> None:
    """Delete lifecycle-tracking tags added by the agent (``deployed-*``, ``pin-*``).

    ``batch_delete_image`` on a tag only removes the tag pointer, not the
    underlying image digest, so this is safe for the running service.
    """
    ecr = session.client("ecr", region_name=region)
    try:
        images = ecr.list_images(
            repositoryName=REPO_NAME, filter={"tagStatus": "TAGGED"}
        )
    except ClientError as exc:
        print(f"[pre] could not list images to strip agent tags: {exc}")
        return
    for img in images.get("imageIds", []):
        tag = img.get("imageTag", "")
        if not any(tag.startswith(p) for p in AGENT_TAG_PREFIXES):
            continue
        try:
            ecr.batch_delete_image(
                repositoryName=REPO_NAME, imageIds=[{"imageTag": tag}]
            )
            print(f"[pre] stripped agent tag {tag}")
        except ClientError as exc:
            print(f"[pre] failed to strip agent tag {tag}: {exc}")


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
            print("[pre] service is already stalled on the expired digest")
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
    print(f"[pre] rolling out {broken_arn} (pinned to the expired digest)")

    deadline = time.time() + 480
    while time.time() < deadline:
        svc = service_state(ecs, CLUSTER_NAME, SERVICE_NAME)
        if (
            len(svc["deployments"]) >= 2
            and pull_failure_visible(ecs, svc)
            and svc["runningCount"] >= 2
        ):
            print("[pre] stalled rollout reproduced")
            record_poisoned_revisions(session, region, [broken_arn])
            return
        time.sleep(20)
    raise RuntimeError("timed out reproducing the stalled rollout")


# ----------------------------------------------------------------------------
# Reset the ECR image auditor back to the CDK-declared baseline.
#
# The audit alarm fires on the Checkout/Delivery/ImageAuditAccessErrors
# metric, which is fed by a CloudWatch Logs MetricFilter matching the
# "ERROR scan findings unavailable" line the audit function emits when its
# ecr:DescribeImageScanFindings call is denied. The CDK grants the audit
# role only ecr:{BatchGetImage,DescribeImages,DescribeRepositories,
# ListImages} — the scan-findings call is *supposed* to be denied every
# invocation, which is what drives the alarm into ALARM organically.
# ----------------------------------------------------------------------------
AUDIT_BASELINE_CODE = "\n".join(
    [
        "import json, os, time",
        "import boto3",
        "",
        'ddb = boto3.client("dynamodb")',
        'ecr = boto3.client("ecr")',
        'TABLE = os.environ["REGISTRY_TABLE"]',
        'REPOS = [r for r in os.environ["REPOSITORIES"].split(",") if r]',
        'PIN_KEYS = [k for k in os.environ["PIN_KEYS"].split(",") if k]',
        "",
        "",
        "def handler(event, context):",
        "    scan_errors = 0",
        "    for repo in REPOS:",
        "        try:",
        '            images = ecr.describe_images(repositoryName=repo, maxResults=100)["imageDetails"]',
        "        except Exception as exc:",
        '            print("ERROR describe_images repository=%s: %s" % (repo, exc))',
        "            continue",
        '        print("audited repository=%s images=%d" % (repo, len(images)))',
        "        for detail in images[:3]:",
        '            digest = detail["imageDigest"]',
        "            try:",
        '                res = ecr.describe_image_scan_findings(repositoryName=repo, imageId={"imageDigest": digest})',
        '                print("scan repository=%s digest=%s status=%s" % (repo, digest, res["imageScanStatus"]["status"]))',
        "            except Exception as exc:",
        "                scan_errors += 1",
        '                print("ERROR scan findings unavailable repository=%s digest=%s: %s" % (repo, digest, exc))',
        "    missing = []",
        "    for key in PIN_KEYS:",
        "        items = ddb.query(",
        "            TableName=TABLE,",
        '            KeyConditionExpression="pk = :p",',
        '            ExpressionAttributeValues={":p": {"S": key}},',
        '        ).get("Items", [])',
        "        for item in items:",
        '            digest = item.get("imageDigest", {}).get("S")',
        '            repo = item.get("repository", {}).get("S")',
        "            if not digest or not repo:",
        "                continue",
        "            try:",
        '                ecr.describe_images(repositoryName=repo, imageIds=[{"imageDigest": digest}])',
        "            except ecr.exceptions.ImageNotFoundException:",
        '                missing.append({"repository": repo, "digest": digest, "pin": item.get("sk", {}).get("S")})',
        '                print("reconcile discrepancy for pin=%s repository=%s digest=%s" % (item.get("sk", {}).get("S"), repo, digest))',
        "            except Exception as exc:",
        '                print("ERROR reconcile repository=%s digest=%s: %s" % (repo, digest, exc))',
        "    ddb.put_item(TableName=TABLE, Item={",
        '        "pk": {"S": "channel:D91E"},',
        '        "sk": {"S": str(int(time.time()))},',
        '        "missingPinnedImages": {"S": json.dumps(missing)},',
        '        "scanAccessErrors": {"N": str(scan_errors)},',
        "    })",
        '    print("audit complete missing=%d scan_errors=%d" % (len(missing), scan_errors))',
        '    return {"missingPinnedImages": missing, "scanAccessErrors": scan_errors}',
    ]
)


def reset_audit_baseline(session: boto3.Session, region: str) -> None:
    """Reset the audit Lambda to its CDK-declared broken baseline.

    The ``describe_image_scan_findings`` call must keep raising AccessDenied.
    """
    lam = session.client("lambda", region_name=region)
    iam = session.client("iam", region_name=region)

    try:
        fn_cfg = lam.get_function_configuration(FunctionName=AUDIT_FUNCTION)
    except ClientError as exc:
        print(f"[pre] audit function unavailable, skipping reset: {exc}")
        return

    role_arn: str = fn_cfg.get("Role", "")
    role_name = role_arn.split("/")[-1] if role_arn else ""

    def _grants_scan_findings(doc: Dict[str, Any]) -> bool:
        for st in doc.get("Statement", []) or []:
            if st.get("Effect") != "Allow":
                continue
            actions = st.get("Action")
            if isinstance(actions, str):
                actions = [actions]
            for a in actions or []:
                al = str(a).lower()
                if al in ("ecr:describeimagescanfindings", "ecr:*", "*"):
                    return True
        return False

    if role_name:
        try:
            for policy_name in iam.list_role_policies(RoleName=role_name)[
                "PolicyNames"
            ]:
                if policy_name.startswith("ImageAuditFnServiceRoleDefaultPolicy"):
                    continue
                doc = iam.get_role_policy(RoleName=role_name, PolicyName=policy_name)[
                    "PolicyDocument"
                ]
                if _grants_scan_findings(doc):
                    iam.delete_role_policy(RoleName=role_name, PolicyName=policy_name)
                    print(
                        f"[pre] deleted extra audit-role inline policy "
                        f"{policy_name} (granted scan-findings access)"
                    )
        except ClientError as exc:
            print(f"[pre] audit-role inline-policy sweep failed: {exc}")

        try:
            for pol in iam.list_attached_role_policies(RoleName=role_name)[
                "AttachedPolicies"
            ]:
                meta = iam.get_policy(PolicyArn=pol["PolicyArn"])["Policy"]
                pv = iam.get_policy_version(
                    PolicyArn=pol["PolicyArn"], VersionId=meta["DefaultVersionId"]
                )["PolicyVersion"]["Document"]
                if isinstance(pv, str):
                    pv = json.loads(pv)
                if _grants_scan_findings(pv):
                    iam.detach_role_policy(
                        RoleName=role_name, PolicyArn=pol["PolicyArn"]
                    )
                    print(
                        f"[pre] detached managed policy {pol['PolicyArn']} "
                        "from audit role (granted scan-findings access)"
                    )
        except ClientError as exc:
            print(f"[pre] audit-role attached-policy sweep failed: {exc}")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        info = zipfile.ZipInfo("index.py")
        info.external_attr = 0o644 << 16
        zf.writestr(info, AUDIT_BASELINE_CODE)
    zip_bytes = buf.getvalue()

    try:
        lam.update_function_code(
            FunctionName=AUDIT_FUNCTION,
            ZipFile=zip_bytes,
            Publish=False,
        )
    except ClientError as exc:
        print(f"[pre] audit code reset failed: {exc}")
        return

    waiter = lam.get_waiter("function_updated_v2")
    try:
        waiter.wait(
            FunctionName=AUDIT_FUNCTION,
            WaiterConfig={"Delay": 3, "MaxAttempts": 40},
        )
    except ClientError as exc:
        print(f"[pre] audit code update did not settle in time: {exc}")
    print("[pre] audit function code reset to CDK baseline")


# ----------------------------------------------------------------------------
# observability
# ----------------------------------------------------------------------------
def generate_observability(session: boto3.Session, region: str) -> None:
    lam = session.client("lambda", region_name=region)
    cw = session.client("cloudwatch", region_name=region)

    for i in range(3):
        resp = lam.invoke(
            FunctionName=PROBE_FUNCTION, InvocationType="RequestResponse", Payload=b"{}"
        )
        payload = resp["Payload"].read().decode()
        if resp.get("FunctionError"):
            raise RuntimeError(f"synthetic probe failed: {payload}")
        print(f"[pre] probe {i}: {payload}")
        time.sleep(5)

    for i in range(3):
        resp = lam.invoke(
            FunctionName=AUDIT_FUNCTION, InvocationType="RequestResponse", Payload=b"{}"
        )
        payload = resp["Payload"].read().decode()
        print(f"[pre] audit {i}: {payload[:400]}")
        if resp.get("FunctionError"):
            raise RuntimeError(f"image audit failed: {payload}")
        time.sleep(5)

    deadline = time.time() + 420
    while time.time() < deadline:
        state = cw.describe_alarms(AlarmNames=[AUDIT_ALARM])["MetricAlarms"][0][
            "StateValue"
        ]
        print(f"[pre] {AUDIT_ALARM} state={state}")
        if state == "ALARM":
            return
        time.sleep(30)
        session.client("lambda", region_name=region).invoke(
            FunctionName=AUDIT_FUNCTION, InvocationType="Event", Payload=b"{}"
        )
    raise RuntimeError(f"{AUDIT_ALARM} did not reach ALARM")


def run(session: Optional[boto3.Session] = None, region: str = REGION, **kwargs):
    if session is None:
        session = boto3.Session(region_name=region)
    account = session.client("sts", region_name=region).get_caller_identity()["Account"]

    reset_repository_controls(session, region, account)
    ensure_release_tag(session, region)
    reset_service_deployment_configuration(session, region)
    strip_agent_added_tags(session, region)
    reset_stalled_rollout(session, region, account)
    reset_audit_baseline(session, region)
    generate_observability(session, region)

    out_dir = Path("/logs/pre_invoke")
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "placeholder.json").write_text(json.dumps({}))
    print("[pre] baseline ready")


if __name__ == "__main__":
    run()
