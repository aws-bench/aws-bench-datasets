"""Setup script for stack ecs-a32gg1f3b (troubleshooting-multiservice).
Builds a Docker image with vulnerable packages and pushes it to the ECR
repository created by the stack, so the Fargate service can pull it.
Requires Docker to be installed and running.
"""

import base64
import sys
import subprocess
import tempfile
import shutil
import boto3


REGION = "us-east-1"
IMAGE_TAG = "a3f1c2e4-9b7d-4e8a-b6f0-2d5c8e1a4f7b_service_main"

DOCKERFILE = """\
FROM --platform=linux/amd64 public.ecr.aws/amazonlinux/amazonlinux:2

RUN yum install -y libxml2-python-2.9.1-6.amzn2.5.18 || yum install -y libxml2-python

# gcc + python3-devel are required by streamlit==1.23.1's transitive deps that
# build native wheels on AL2 (e.g. backports.zoneinfo on Python 3.7 — AL2 ships
# Python 3.7 by default which still uses the C extension path). Without these,
# pip falls back to a source build and fails on missing gcc / Python.h.
RUN yum install -y python3 python3-pip python3-devel gcc && \\
    pip3 install --upgrade pip && \\
    pip3 install streamlit==1.23.1

WORKDIR /app

RUN echo 'import streamlit as st\\n\\
st.title("Vulnerable Application")\\n\\
st.write("This application contains vulnerable packages for security testing.")\\n\\
st.write("Package: libxml2-python 2.9.1-6.amzn2.5.18")\\n\\
' > app.py

EXPOSE 8501
CMD ["streamlit", "run", "app.py", "--server.port=8501", "--server.address=0.0.0.0"]
"""


def _run(cmd, **kwargs):
    """Run cmd and raise with captured stderr on non-zero exit.

    Streams stdout/stderr live (no capture) so long-running docker builds
    don't appear hung. Use _run_capture when stdin needs to be piped
    (e.g. docker login --password-stdin).
    """
    print(f"Running: {cmd}")
    result = subprocess.run(cmd, shell=isinstance(cmd, str), **kwargs)
    if result.returncode != 0:
        raise RuntimeError(f"Command failed (exit {result.returncode}): {cmd}")


def _run_capture(cmd, input_=None, **kwargs):
    """Run cmd with captured output; raise with stderr on failure."""
    print(f"Running: {cmd}")
    result = subprocess.run(
        cmd,
        shell=isinstance(cmd, str),
        input=input_,
        capture_output=True,
        text=True,
        **kwargs,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Command failed (exit {result.returncode}): {cmd}\nstderr: {result.stderr}"
        )
    return result


def _image_tag_exists(session, region, repo_name, tag):
    """Return True if the given tag already exists in the ECR repo."""
    ecr = session.client("ecr", region_name=region)
    try:
        ecr.describe_images(
            repositoryName=repo_name,
            imageIds=[{"imageTag": tag}],
        )
        return True
    except ecr.exceptions.ImageNotFoundException:
        return False


def _build_and_push(ecr_uri, session, region):
    build_dir = tempfile.mkdtemp(prefix="docker_build_")
    try:
        with open(f"{build_dir}/Dockerfile", "w") as f:
            f.write(DOCKERFILE)

        full_tag = f"{ecr_uri}:{IMAGE_TAG}"

        _run(f"docker build -t {full_tag} .", cwd=build_dir)

        # Auth via boto3 session (not CLI) so injected credentials are used
        registry = ecr_uri.split("/")[0]
        ecr = session.client("ecr", region_name=region)
        token = ecr.get_authorization_token()["authorizationData"][0]
        user, password = (
            base64.b64decode(token["authorizationToken"]).decode().split(":", 1)
        )

        _run_capture(
            f"docker login --username {user} --password-stdin {registry}",
            input_=password,
        )

        _run(f"docker push {full_tag}")
        print(f"Successfully pushed: {full_tag}")
    finally:
        shutil.rmtree(build_dir, ignore_errors=True)


def run(session=None, region=REGION, **parameters):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY", region_name=region)
    account = session.client("sts").get_caller_identity()["Account"]
    repo_name = f"ecrrepo-{account}-{region}"
    ecr_uri = f"{account}.dkr.ecr.{region}.amazonaws.com/{repo_name}"

    print(f"Account:    {account}")
    print(f"ECR URI:    {ecr_uri}")
    print(f"Image tag:  {IMAGE_TAG}")

    if _image_tag_exists(session, region, repo_name, IMAGE_TAG):
        print(f"Image {IMAGE_TAG} already present in {repo_name}; skipping build.")
        return

    _run_capture("docker info")
    _build_and_push(ecr_uri, session, region)


if __name__ == "__main__":
    try:
        run()
    except Exception as e:
        print(f"Setup failed: {e}", file=sys.stderr)
        sys.exit(1)
