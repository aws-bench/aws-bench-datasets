"""
Setup script for stack ecs-t3oo10okn (troubleshooting-multiservice).

Creates the ECR repository imported by the stack and pushes a single dummy image
with tag dev_build_service_main. This is the only image present in the repo,
which does not match the tags referenced in the task definition — that mismatch
is the intentional troubleshooting scenario.
"""

import base64
import subprocess
import sys
import time
import boto3
from botocore.config import Config

CONFIG = Config(connect_timeout=5, read_timeout=60)

# Pin by digest (not :latest) so re-runs are deterministic. Sourced from
# Docker Hub's busybox:1.36 manifest list. Bump deliberately, not silently.
BUSYBOX_IMAGE = (
    "busybox@sha256:b7f3d86d6e84fc17718c48bcde1450807faa2d56704205c697b4bd5df7b9e29f"
)


def run(session=None, region="us-east-1", **parameters) -> None:
    if session is None:
        session = boto3.Session(profile_name="PRIMARY", region_name=region)
    account = session.client("sts", config=CONFIG).get_caller_identity()["Account"]

    cfn = session.client("cloudformation", region_name=region, config=CONFIG)
    outputs = {
        o["OutputKey"]: o["OutputValue"]
        for o in cfn.describe_stacks(
            StackName=f"troubleshooting-multiservice-ecs-t3oo10okn-{region}"
        )["Stacks"][0]["Outputs"]
    }
    repo_uri = outputs["EcrRepositoryUri"]
    repo_name = repo_uri.split("/", 1)[1]

    ecr = session.client("ecr", region_name=region, config=CONFIG)

    # Create repo if it doesn't exist
    try:
        ecr.create_repository(repositoryName=repo_name)
        print(f"Created ECR repository: {repo_name}")
    except ecr.exceptions.RepositoryAlreadyExistsException:
        print(f"ECR repository already exists: {repo_name}")

    # Auth Docker to ECR
    token = ecr.get_authorization_token()["authorizationData"][0]
    user, password = (
        base64.b64decode(token["authorizationToken"]).decode().split(":", 1)
    )
    registry = token["proxyEndpoint"]
    _sh(
        ["docker", "login", "--username", user, "--password-stdin", registry],
        input=password,
    )

    # Build and push a minimal scratch image with the expected tag
    tag = "dev_build_service_main"
    image = f"{repo_uri}:{tag}"

    # Use busybox as a minimal stand-in (scratch requires cross-platform tricks)
    _sh(["docker", "pull", BUSYBOX_IMAGE])
    _sh(["docker", "tag", BUSYBOX_IMAGE, image])
    _sh(["docker", "push", image])
    print(f"Pushed image: {image}")

    # Verify only this one tag exists (retry for ECR eventual consistency)
    for attempt in range(5):
        images = ecr.list_images(repositoryName=repo_name)["imageIds"]
        tags = [i.get("imageTag") for i in images if i.get("imageTag")]
        if tags == [tag]:
            break
        print(f"Waiting for ECR consistency (attempt {attempt + 1})...")
        time.sleep(3)
    print(f"Images in repo: {tags}")
    if tags != [tag]:
        raise RuntimeError(f"Unexpected images in repo: {tags}")


def _sh(cmd: list, input: str = None) -> None:
    result = subprocess.run(
        cmd,
        input=input.encode() if input else None,
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Command {cmd} failed (exit {result.returncode}): {result.stderr.decode()}"
        )


if __name__ == "__main__":
    try:
        run()
    except Exception as e:
        print(f"Setup failed: {e}", file=sys.stderr)
        sys.exit(1)
