"""Verification for the stalled checkout-api rollout remediation."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
CLUSTER_NAME = os.environ.get("CLUSTER_NAME", "checkout-platform")
SERVICE_NAME = os.environ.get("SERVICE_NAME", "checkout-api-svc")
REPO_NAME = os.environ.get("REPO_NAME", "platform/checkout-api")
TASK_FAMILY = os.environ.get("TASK_FAMILY", "checkout-api")
TARGET_GROUP_NAME = os.environ.get("TARGET_GROUP_NAME", "checkout-api-tg")
CANARY_PROJECT = os.environ.get("CANARY_PROJECT_NAME", "checkout-api-canary-build")
CONTAINER_NAME = "checkout-api"

RELEASE_TAG_PATTERNS = ("v", "release")

# SSM parameter that setup / pre_invoke / post_invoke write the currently
# ACTIVE poisoned task-definition ARNs to. Kept in sync so this verifier does
# not rely on hardcoded revision numbers that drift across trials.
POISONED_REVISION_PARAM = os.environ.get(
    "POISONED_REVISION_PARAM", "/platform/ecs/poisoned-revision-arns"
)

ACCEPTED_MEDIA_TYPES = [
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.v1+json",
]

session = boto3.Session(region_name=REGION)


# ---------------------------------------------------------------- helpers ----
def describe_service() -> Dict[str, Any]:
    ecs = session.client("ecs")
    return ecs.describe_services(cluster=CLUSTER_NAME, services=[SERVICE_NAME])[
        "services"
    ][0]


def primary_deployment(svc: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    return next(
        (d for d in svc.get("deployments", []) if d.get("status") == "PRIMARY"), None
    )


def container_image(task_def_arn: str) -> str:
    ecs = session.client("ecs")
    td = ecs.describe_task_definition(taskDefinition=task_def_arn)["taskDefinition"]
    for cdef in td["containerDefinitions"]:
        if cdef["name"] == CONTAINER_NAME:
            return cdef["image"]
    return td["containerDefinitions"][0]["image"]


def image_exists(image_reference: str) -> bool:
    ecr = session.client("ecr")
    if "@" in image_reference:
        image_id = {"imageDigest": image_reference.split("@", 1)[1]}
    else:
        tag = (
            image_reference.rsplit(":", 1)[1]
            if ":" in image_reference.rsplit("/", 1)[-1]
            else "latest"
        )
        image_id = {"imageTag": tag}
    try:
        ecr.describe_images(repositoryName=REPO_NAME, imageIds=[image_id])
        return True
    except Exception:
        return False


def tag_map() -> Dict[str, str]:
    """tag -> digest for every image currently in the repository."""
    ecr = session.client("ecr")
    mapping: Dict[str, str] = {}
    paginator = ecr.get_paginator("describe_images")
    for page in paginator.paginate(repositoryName=REPO_NAME):
        for detail in page["imageDetails"]:
            for tag in detail.get("imageTags", []):
                mapping[tag] = detail["imageDigest"]
    return mapping


def manifest_for(digest: str) -> Dict[str, Any]:
    ecr = session.client("ecr")
    resp = ecr.batch_get_image(
        repositoryName=REPO_NAME,
        imageIds=[{"imageDigest": digest}],
        acceptedMediaTypes=ACCEPTED_MEDIA_TYPES,
    )
    return resp["images"][0]


def put_tag(manifest: Dict[str, Any], tag: str) -> None:
    ecr = session.client("ecr")
    kwargs: Dict[str, Any] = {
        "repositoryName": REPO_NAME,
        "imageManifest": manifest["imageManifest"],
        "imageTag": tag,
    }
    if manifest.get("imageManifestMediaType"):
        kwargs["imageManifestMediaType"] = manifest["imageManifestMediaType"]
    ecr.put_image(**kwargs)


def wait_build(build_id: str, deadline_s: int = 600) -> str:
    cb = session.client("codebuild")
    deadline = time.time() + deadline_s
    while time.time() < deadline:
        build = cb.batch_get_builds(ids=[build_id])["builds"][0]
        if build.get("buildComplete"):
            return build.get("buildStatus", "UNKNOWN")
        time.sleep(15)
    return "TIMED_OUT"


# ------------------------------------------------------------- criteria ------
@criterion(
    description="checkout-api has a single completed deployment at its original desired count"
)
def deployment_completed(workspace: Path) -> bool:
    try:
        svc = describe_service()
        primary = primary_deployment(svc)
        if primary is None:
            return False
        desired = svc.get("desiredCount")
        if not isinstance(desired, int) or desired <= 0:
            return False
        return all(
            [
                len(svc.get("deployments", [])) == 1,
                primary.get("rolloutState") == "COMPLETED",
                svc.get("runningCount") == desired,
                svc.get("pendingCount") == 0,
                primary.get("runningCount") == desired,
            ]
        )
    except Exception:
        return False


@criterion(
    description="Running revision uses a checkout-api image that still resolves in ECR"
)
def running_image_resolves(workspace: Path) -> bool:
    try:
        svc = describe_service()
        primary = primary_deployment(svc)
        if primary is None:
            return False
        arn = primary["taskDefinition"]
        image = container_image(arn)
        return REPO_NAME in image and image_exists(image)
    except Exception:
        return False


@criterion(description="Internal ALB reports the replacement tasks healthy")
def alb_targets_healthy(workspace: Path) -> bool:
    try:
        ecs = session.client("ecs")
        svc = ecs.describe_services(cluster=CLUSTER_NAME, services=[SERVICE_NAME])[
            "services"
        ][0]
        desired = svc.get("desiredCount")
        if not isinstance(desired, int) or desired <= 0:
            return False
        elb = session.client("elbv2")
        tg_arn = elb.describe_target_groups(Names=[TARGET_GROUP_NAME])["TargetGroups"][
            0
        ]["TargetGroupArn"]
        health = elb.describe_target_health(TargetGroupArn=tg_arn)[
            "TargetHealthDescriptions"
        ]
        states: List[str] = [h["TargetHealth"]["State"] for h in health]
        healthy = states.count("healthy")
        bad = len([s for s in states if s in ("unhealthy", "unavailable")])
        return healthy >= desired and bad == 0
    except Exception:
        return False


@criterion(description="Repository still expires untagged images")
def untagged_expiry_retained(workspace: Path) -> bool:
    try:
        ecr = session.client("ecr")
        policy = json.loads(
            ecr.get_lifecycle_policy(repositoryName=REPO_NAME)["lifecyclePolicyText"]
        )
        for rule in policy.get("rules", []):
            selection = rule.get("selection", {})
            action = rule.get("action", {})
            if (
                selection.get("tagStatus") == "untagged"
                and action.get("type") == "expire"
            ):
                return True
        return False
    except Exception:
        return False


@criterion(
    description="Canary pipeline still builds and overwrites latest without moving release tags"
)
def canary_pipeline_still_works(workspace: Path) -> bool:
    try:
        before = tag_map()
        latest_before = before.get("latest")
        release_before = {t: d for t, d in before.items() if t != "latest"}
        if not latest_before or not release_before:
            return False

        cb = session.client("codebuild")
        build_id = cb.start_build(projectName=CANARY_PROJECT)["build"]["id"]
        status = wait_build(build_id)
        if status != "SUCCEEDED":
            print(f"canary build {build_id} ended in {status}")
            return False

        after = tag_map()
        latest_after = after.get("latest")
        if not latest_after or latest_after == latest_before:
            print("canary build did not publish a new latest image")
            return False
        for tag, digest in release_before.items():
            if after.get(tag) != digest:
                print(f"release tag {tag} moved from {digest} to {after.get(tag)}")
                return False
        return True
    except Exception as exc:
        print(f"canary verification error: {exc}")
        return False


@criterion(description="A release tag can no longer be reassigned to a different image")
def release_tag_immutable(workspace: Path) -> bool:
    try:
        ecr = session.client("ecr")
        mapping = tag_map()
        candidates = [t for t in ("v2.1", "v2.0") if t in mapping]
        candidates += [
            t for t in sorted(mapping) if t != "latest" and t not in candidates
        ]

        if candidates:
            tag = candidates[0]
            original = mapping[tag]
            other = next((d for d in set(mapping.values()) if d != original), None)
            if other is None:
                return False
            try:
                put_tag(manifest_for(other), tag)
            except ClientError as exc:
                code = exc.response.get("Error", {}).get("Code", "")
                if code == "ImageTagAlreadyExistsException":
                    print(f"release tag {tag} is immutable")
                    return True
                print(f"unexpected error probing tag immutability: {code} {exc}")
                return False
            except Exception as exc:
                print(f"unexpected error probing tag immutability: {exc}")
                return False
            # The move succeeded: release tags are still mutable. Undo it.
            try:
                put_tag(manifest_for(original), tag)
            except Exception:
                pass
            print(f"release tag {tag} was still movable")
            return False

        repo = ecr.describe_repositories(repositoryNames=[REPO_NAME])["repositories"][0]
        mutability = repo.get("imageTagMutability")
        filters = [
            f.get("filter", "")
            for f in repo.get("imageTagMutabilityExclusionFilters", [])
        ]
        if mutability == "IMMUTABLE":
            return False  # would also block the canary from overwriting latest
        if mutability == "IMMUTABLE_WITH_EXCLUSION":
            return any(f.startswith("latest") for f in filters)
        if mutability == "MUTABLE_WITH_EXCLUSION":
            # Must exclude at least one release-tag pattern so release tags are
            # pinned. A bare `bool(filters)` would accept a filter that only
            # covers `latest*` (which does not protect release tags at all).
            return bool(filters) and any(
                f.startswith(RELEASE_TAG_PATTERNS) for f in filters
            )
        return False
    except Exception as exc:
        print(f"immutability verification error: {exc}")
        return False


# ---------------------------------------------------------------- hardening --
# The following criteria enforce the operational hardening the instruction
# requires ("harden the account so this specific class of failure cannot
# recur").


@criterion(
    description="ECS deployment circuit breaker is enabled on the service",
)
def deployment_circuit_breaker_enabled(workspace: Path) -> bool:
    try:
        svc = describe_service()
        dcb = (svc.get("deploymentConfiguration") or {}).get(
            "deploymentCircuitBreaker"
        ) or {}
        return bool(dcb.get("enable"))
    except Exception as exc:
        print(f"circuit breaker verification error: {exc}")
        return False


@criterion(
    description=(
        "ECR repo policy has a scoped explicit Deny on ecr:BatchDeleteImage "
        "(non-wildcard Resource or a Condition block)"
    ),
)
def ecr_repo_policy_denies_batch_delete_image(workspace: Path) -> bool:
    """Verify a scoped resource-policy Deny that prevents surgical release-tag deletes.

    Passes when the Deny statement is scoped — either via any ``Condition``
    block that could restrict to tagged images, or via a non-wildcard
    ``Resource``. A blanket Deny with no Condition and Resource=* fails.
    ECR-managed expiry is service-side and not gated by the repo policy.
    """
    try:
        ecr = session.client("ecr")
        try:
            policy_text = ecr.get_repository_policy(repositoryName=REPO_NAME)[
                "policyText"
            ]
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "")
            if code in ("RepositoryPolicyNotFoundException",):
                return False
            print(f"ecr policy read error: {code} {exc}")
            return False
        policy = json.loads(policy_text)
        stmts = policy.get("Statement", [])
        if isinstance(stmts, dict):
            stmts = [stmts]
        for stmt in stmts:
            if stmt.get("Effect") != "Deny":
                continue
            actions = stmt.get("Action")
            if isinstance(actions, str):
                actions = [actions]
            actions = actions or []
            covers_delete = any(
                a in ("ecr:BatchDeleteImage", "ecr:*", "*") for a in actions
            )
            if not covers_delete:
                continue
            condition = stmt.get("Condition") or {}
            resource = stmt.get("Resource")
            broad_resource = resource in (None, "*", ["*"])
            if condition or not broad_resource:
                return True
            print(
                "Deny on ecr:BatchDeleteImage is over-broad "
                "(Principal-wide, no Condition, Resource=*); scope it with a "
                "Condition (e.g., ecr:ResourceTag) or a narrower Resource."
            )
        return False
    except Exception as exc:
        print(f"ecr policy verification error: {exc}")
        return False


def _poisoned_revision_identifiers() -> List[str]:
    """Return the task-definition identifiers to evaluate for the criterion.

    Preferred source: the SSM parameter setup / pre_invoke / post_invoke seed
    with the currently ACTIVE poisoned revision ARN(s). Falls back to
    ``<family>:2`` / ``:3`` when that parameter is absent.
    """
    ssm = session.client("ssm")
    try:
        raw = ssm.get_parameter(Name=POISONED_REVISION_PARAM)["Parameter"]["Value"]
        parsed = json.loads(raw)
        if isinstance(parsed, list) and parsed:
            return [str(x) for x in parsed if x]
    except ClientError as exc:
        print(f"poisoned-revision SSM lookup failed ({exc}); using fallback")
    except (ValueError, KeyError) as exc:
        print(f"poisoned-revision SSM value invalid ({exc}); using fallback")
    return [f"{TASK_FAMILY}:{rev}" for rev in (2, 3)]


@criterion(
    description=(
        "Task-definition revisions pinned to the expired image digest are INACTIVE"
    ),
)
def poisoned_task_definitions_inactive(workspace: Path) -> bool:
    try:
        ecs = session.client("ecs")
        identifiers = _poisoned_revision_identifiers()
        seen = 0
        for ident in identifiers:
            try:
                td = ecs.describe_task_definition(taskDefinition=ident)[
                    "taskDefinition"
                ]
            except ClientError as exc:
                # A missing revision (e.g. hardcoded fallback for an env whose
                # revision numbers have drifted) is skipped rather than failed.
                # If NO identifier resolves, ``seen`` stays zero and this fails.
                print(f"skipping {ident} (not describable): {exc}")
                continue
            seen += 1
            if td.get("status") != "INACTIVE":
                print(f"{ident} status={td.get('status')} (expected INACTIVE)")
                return False
        if seen == 0:
            print("no poisoned revisions could be resolved")
            return False
        return True
    except Exception as exc:
        print(f"poisoned-revision verification error: {exc}")
        return False


@criterion(
    description=(
        "durable deployed-/pin- tag on the currently-running digest "
        "protects it from untagged expiry"
    ),
)
def deployed_pin_tag_present(workspace: Path) -> bool:
    """A durable operational tag protects the running digest.

    Accepts any tag on the running digest that is neither ``latest`` (the
    canary's own mutable channel) nor a release-tag pattern (``v*``,
    ``release*``) — those already exist by the time the trial starts. What
    the agent must add is *any additional* stable identifier so the currently
    deployed image is not left unnamed if release tags later move away.
    """
    try:
        svc = describe_service()
        primary = primary_deployment(svc)
        if primary is None:
            return False
        image = container_image(primary["taskDefinition"])
        running_digest: Optional[str] = None
        if "@" in image:
            running_digest = image.split("@", 1)[1]
        mapping = tag_map()
        if running_digest is None:
            tail = image.rsplit("/", 1)[-1]
            tag = tail.rsplit(":", 1)[1] if ":" in tail else "latest"
            running_digest = mapping.get(tag)
        if not running_digest:
            return False
        for tag, digest in mapping.items():
            if digest != running_digest:
                continue
            lower = tag.lower()
            if lower == "latest":
                continue
            if lower.startswith(RELEASE_TAG_PATTERNS):
                continue
            # Any tag on the running digest that is not the canary's mutable
            # channel and not a release-pattern tag qualifies as a durable
            # operational identifier.
            return True
        return False
    except Exception as exc:
        print(f"deployed-pin-tag verification error: {exc}")
        return False
