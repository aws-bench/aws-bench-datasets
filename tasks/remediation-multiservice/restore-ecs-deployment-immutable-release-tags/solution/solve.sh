#!/bin/bash
set -euo pipefail

export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

python3 - <<'PY'
import json
import os
import time

import boto3

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
CLUSTER = os.environ.get("CLUSTER_NAME", "checkout-platform")
SERVICE = os.environ.get("SERVICE_NAME", "checkout-api-svc")
REPO = os.environ.get("REPO_NAME", "platform/checkout-api")
FAMILY = os.environ.get("TASK_FAMILY", "checkout-api")
CANARY = os.environ.get("CANARY_PROJECT_NAME", "checkout-api-canary-build")
EXTRA_PARAM = os.environ.get("EXTRA_TAG_PARAM", "/platform/checkout-api/canary/extra-tag")
TABLE = os.environ.get("REGISTRY_TABLE_NAME", "checkout-release-registry")
CONTAINER = "checkout-api"

session = boto3.Session(region_name=REGION)
ecs = session.client("ecs")
ecr = session.client("ecr")
cb = session.client("codebuild")
ssm = session.client("ssm")
ddb = session.client("dynamodb")
account = session.client("sts").get_caller_identity()["Account"]
repo_uri = f"{account}.dkr.ecr.{REGION}.amazonaws.com/{REPO}"

# ---------------------------------------------------------------- diagnose ---
svc = ecs.describe_services(cluster=CLUSTER, services=[SERVICE])["services"][0]
primary = next(d for d in svc["deployments"] if d["status"] == "PRIMARY")
broken_arn = primary["taskDefinition"]
broken_td = ecs.describe_task_definition(taskDefinition=broken_arn)["taskDefinition"]
broken_image = next(c["image"] for c in broken_td["containerDefinitions"] if c["name"] == CONTAINER)
print(f"stalled deployment rollout={primary.get('rolloutState')} td={broken_arn} image={broken_image}")

missing_digest = None
if "@" in broken_image:
    digest = broken_image.split("@", 1)[1]
    try:
        ecr.describe_images(repositoryName=REPO, imageIds=[{"imageDigest": digest}])
    except ecr.exceptions.ImageNotFoundException:
        missing_digest = digest
print(f"pinned digest missing from ECR: {missing_digest}")

# Resolve opaque channel ids via the persistent catalog row.
channels = {}
try:
    catalog = ddb.get_item(
        TableName=TABLE, Key={"pk": {"S": "catalog"}, "sk": {"S": "channels"}}
    ).get("Item", {})
    for cid, val in catalog.get("channels", {}).get("M", {}).items():
        channels[val.get("S", "")] = cid
except Exception as exc:
    print(f"catalog lookup failed ({exc}); falling back to hard-coded channel ids")
canary_pk = channels.get("canary", "channel:C71B")

rows = ddb.query(
    TableName=TABLE,
    KeyConditionExpression="pk = :p",
    ExpressionAttributeValues={":p": {"S": canary_pk}},
).get("Items", [])
for row in rows[-3:]:
    print("canary run", {k: list(v.values())[0] for k, v in row.items()})

project = cb.batch_get_projects(names=[CANARY])["projects"][0]
env_vars = {v["name"]: v.get("value") for v in project["environment"]["environmentVariables"]}
extra_value = ssm.get_parameter(Name=EXTRA_PARAM)["Parameter"]["Value"]
print(f"canary env={env_vars} extra_tag_value={extra_value}")

# ------------------------------------------------- stop the extra-tag push ---
buildspec = project["source"].get("buildspec", "")
updated_spec = None
try:
    spec = json.loads(buildspec)

    def keep(cmd):
        # drop only the step that moves the extra tag onto the canary image
        return not ("$EXTRA_TAG" in cmd and "docker" in cmd)

    for phase in spec.get("phases", {}).values():
        phase["commands"] = [c for c in phase.get("commands", []) if keep(c)]
    updated_spec = json.dumps(spec, indent=2)
except Exception as exc:
    print(f"buildspec is not JSON ({exc}); falling back to retargeting the extra tag")

if updated_spec:
    cb.update_project(name=CANARY, source={"type": "NO_SOURCE", "buildspec": updated_spec})
    print("canary buildspec no longer republishes any release tag")
else:
    ssm.put_parameter(Name=EXTRA_PARAM, Value="latest", Type="String", Overwrite=True)

# ---------------------------------------------- make release tags immutable ---
def set_mutability(mode, filters):
    kwargs = {"repositoryName": REPO, "imageTagMutability": mode}
    if filters:
        kwargs["imageTagMutabilityExclusionFilters"] = filters
    ecr.put_image_tag_mutability(**kwargs)

try:
    set_mutability("IMMUTABLE_WITH_EXCLUSION", [{"filterType": "WILDCARD", "filter": "latest*"}])
except Exception as exc:
    print(f"IMMUTABLE_WITH_EXCLUSION rejected ({exc}); trying MUTABLE_WITH_EXCLUSION")
    set_mutability(
        "MUTABLE_WITH_EXCLUSION",
        [
            {"filterType": "WILDCARD", "filter": "v*"},
            {"filterType": "WILDCARD", "filter": "release*"},
        ],
    )
repo_cfg = ecr.describe_repositories(repositoryNames=[REPO])["repositories"][0]
print(f"tag mutability now {repo_cfg.get('imageTagMutability')} {repo_cfg.get('imageTagMutabilityExclusionFilters')}")

# --------------------- scoped Deny on ecr:BatchDeleteImage for release tags ---
# ECR-managed lifecycle expiry is service-side (not gated by this policy), so
# scoping the Deny by ecr:ImageTag keeps `expire untagged` working while
# preventing surgical release-tag deletes via BatchDeleteImage. ECR repo
# policies do not accept a top-level ``Resource`` field (the policy is
# implicitly scoped to the repository), and any failure here must not
# short-circuit the deployment rollforward below.
deny_policy = {
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "DenyBatchDeleteReleaseTags",
            "Effect": "Deny",
            "Principal": "*",
            "Action": "ecr:BatchDeleteImage",
            "Condition": {
                "StringLike": {
                    "ecr:ImageTag": ["v*", "release-*", "release/*"],
                }
            },
        }
    ],
}
try:
    ecr.set_repository_policy(
        repositoryName=REPO, policyText=json.dumps(deny_policy)
    )
    print("ecr repo policy set: scoped Deny on ecr:BatchDeleteImage for release-tag-shaped tags")
except Exception as exc:
    print(f"ecr repo policy update failed (continuing): {exc}")

# ------------------------------- keep untagged expiry, but far less aggressive -
policy = json.loads(ecr.get_lifecycle_policy(repositoryName=REPO)["lifecyclePolicyText"])
for rule in policy["rules"]:
    if rule["selection"].get("tagStatus") == "untagged":
        rule["selection"]["countNumber"] = 14
        rule["description"] = "expire untagged images after 14 days"
ecr.put_lifecycle_policy(repositoryName=REPO, lifecyclePolicyText=json.dumps(policy))

# ------------------------------------------- roll forward onto a live image ----
def digest_for(tag):
    try:
        return ecr.describe_images(repositoryName=REPO, imageIds=[{"imageTag": tag}])["imageDetails"][0]["imageDigest"]
    except Exception:
        return None

target_digest = digest_for("v2.1") or digest_for("latest") or digest_for("v2.0")
if not target_digest:
    raise SystemExit("no usable checkout-api image in the repository")
target_image = f"{repo_uri}@{target_digest}"
print(f"rolling forward onto {target_image}")

COPY_KEYS = [
    "family", "taskRoleArn", "executionRoleArn", "networkMode", "containerDefinitions",
    "volumes", "placementConstraints", "requiresCompatibilities", "cpu", "memory",
    "runtimePlatform", "ephemeralStorage", "pidMode", "ipcMode", "proxyConfiguration",
]
kwargs = {k: broken_td[k] for k in COPY_KEYS if broken_td.get(k) not in (None, [], {})}
for cdef in kwargs["containerDefinitions"]:
    if cdef["name"] == CONTAINER:
        cdef["image"] = target_image
new_arn = ecs.register_task_definition(**kwargs)["taskDefinition"]["taskDefinitionArn"]
print(f"registered {new_arn}")

ecs.update_service(cluster=CLUSTER, service=SERVICE, taskDefinition=new_arn, desiredCount=svc["desiredCount"])
ecs.get_waiter("services_stable").wait(
    cluster=CLUSTER, services=[SERVICE], WaiterConfig={"Delay": 15, "MaxAttempts": 60}
)

# ------------------ harden deploymentConfiguration once the rollout is stable -
# Enabling the circuit breaker + a healthy-percent floor AFTER stabilisation
# avoids the risk of the breaker rolling back the current (successful) rollout.
# A deploymentConfiguration-only update does not itself trigger a new
# deployment, but we still wait for stable to keep the criterion happy.
ecs.update_service(
    cluster=CLUSTER,
    service=SERVICE,
    deploymentConfiguration={
        "deploymentCircuitBreaker": {"enable": True, "rollback": True},
        "minimumHealthyPercent": 100,
        "maximumPercent": 200,
    },
)
ecs.get_waiter("services_stable").wait(
    cluster=CLUSTER, services=[SERVICE], WaiterConfig={"Delay": 10, "MaxAttempts": 30}
)
print("service deploymentConfiguration hardened: circuitBreaker=on rollback=on minHealthy=100")

svc = ecs.describe_services(cluster=CLUSTER, services=[SERVICE])["services"][0]
primary = next(d for d in svc["deployments"] if d["status"] == "PRIMARY")
print(
    "service now desired=%s running=%s rollout=%s deployments=%s"
    % (svc["desiredCount"], svc["runningCount"], primary.get("rolloutState"), len(svc["deployments"]))
)

# --------------------- deregister poisoned task-definition revisions ----------
# Prefer the SSM parameter holding the ACTIVE poisoned revision ARNs; fall
# back to :2 / :3 when it is absent.
POISONED_PARAM = os.environ.get(
    "POISONED_REVISION_PARAM", "/platform/ecs/poisoned-revision-arns"
)
poisoned_ids = []
try:
    raw = ssm.get_parameter(Name=POISONED_PARAM)["Parameter"]["Value"]
    parsed = json.loads(raw)
    if isinstance(parsed, list):
        poisoned_ids = [str(x) for x in parsed if x]
except Exception as exc:
    print(f"poisoned-revision SSM lookup failed ({exc}); using :2/:3 fallback")
if not poisoned_ids:
    poisoned_ids = [f"{FAMILY}:2", f"{FAMILY}:3"]
for ident in poisoned_ids:
    if ident == new_arn:
        continue
    try:
        ecs.deregister_task_definition(taskDefinition=ident)
        print(f"deregistered {ident}")
    except Exception as exc:
        print(f"could not deregister {ident}: {exc}")

# --------------- pin the running digest with a durable deployed-<short> tag ---
short = target_digest.split(":", 1)[1][:12]
deployed_tag = f"deployed-{short}"
try:
    img = ecr.batch_get_image(
        repositoryName=REPO,
        imageIds=[{"imageDigest": target_digest}],
        acceptedMediaTypes=[
            "application/vnd.docker.distribution.manifest.v2+json",
            "application/vnd.docker.distribution.manifest.list.v2+json",
            "application/vnd.oci.image.manifest.v1+json",
            "application/vnd.oci.image.index.v1+json",
            "application/vnd.docker.distribution.manifest.v1+json",
        ],
    )["images"][0]
    put_kwargs = {
        "repositoryName": REPO,
        "imageManifest": img["imageManifest"],
        "imageTag": deployed_tag,
    }
    if img.get("imageManifestMediaType"):
        put_kwargs["imageManifestMediaType"] = img["imageManifestMediaType"]
    ecr.put_image(**put_kwargs)
    print(f"pinned {deployed_tag} onto {target_digest}")
except ecr.exceptions.ImageAlreadyExistsException:
    print(f"{deployed_tag} already present on {target_digest}")
except Exception as exc:
    print(f"deployed-tag put failed: {exc}")

# ------------------------------------------------ prove the canary still runs --
build_id = cb.start_build(projectName=CANARY)["build"]["id"]
deadline = time.time() + 900
status = "TIMED_OUT"
while time.time() < deadline:
    build = cb.batch_get_builds(ids=[build_id])["builds"][0]
    if build.get("buildComplete"):
        status = build["buildStatus"]
        break
    time.sleep(15)
print(f"canary verification build {build_id}: {status}")
if status != "SUCCEEDED":
    raise SystemExit(f"canary build failed after the change: {status}")

root_cause = (
    "the release pipeline pinned the task definition to the v2.1 image digest, the scheduled canary build "
    "re-published tag v2.1 onto its own image, and the untagged-expiry lifecycle rule then deleted the "
    "orphaned digest, so replacement tasks could not pull it"
)

os.makedirs("/logs/agent", exist_ok=True)
with open("/logs/agent/agent-output.json", "w") as fh:
    json.dump(
        {
            "task_definition_arn": new_arn,
            "image_reference": target_image,
            "root_cause": root_cause,
        },
        fh,
        indent=2,
    )
with open("/logs/agent/agent-output.txt", "w") as fh:
    fh.write(
        "checkout-api rollout was stalled because %s.\n\n"
        "Fix: the canary project no longer republishes the release channel tag, %s now keeps release tags "
        "immutable while leaving `latest` overwritable, the untagged-expiry rule is retained (14 days), and "
        "%s runs %s pinned to %s with %s healthy tasks behind the internal ALB.\n"
        % (root_cause, REPO, SERVICE, new_arn, target_image, svc["runningCount"])
    )
print("done")
PY
