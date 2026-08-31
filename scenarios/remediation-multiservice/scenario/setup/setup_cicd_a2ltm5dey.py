"""Seed the acme-corp CI artifact bucket with archived GitHub Actions job logs,
workflow definitions, and published deploy artifacts.

Runs once after `cdk deploy`. Idempotent: every object is overwritten.
"""

from __future__ import annotations

import datetime as dt
import gzip
import io
import json
import time
from typing import Optional

import boto3

REGION = "us-east-1"
STACK_NAME = "remediation-multiservice-CicdOidc-a2ltm5dey-us-east-1"

# Shares the opaque observability prefix with the captured sibling tokens. This
# parameter holds a raw JSON claim template, not a captured JWT.
PAYMENTS_CLAIMS_TEMPLATE_PARAM = "/acme/platform/observability/tokens/f5a3b7c1e8d24069"

PAYMENTS_API_CLAIMS_BASE = {
    "sub": "repo:acme-corp@1042/payments-api@88317:ref:refs/heads/main",
    "aud": "token.actions.githubusercontent.com",
    "iss": "https://token.actions.githubusercontent.com",
    "repository": "acme-corp@1042/payments-api@88317",
    "repository_owner": "acme-corp@1042",
    "repository_id": "88317",
    "repository_owner_id": "1042",
    "repository_visibility": "private",
    "ref": "refs/heads/main",
    "ref_type": "branch",
    "ref_protected": "true",
    "sha": "9a1f6c04c0f1b1b5f6d3d9d70a4b3e8f2c7d5a11",
    "actor": "ci-bot-acme",
    "actor_id": "77219",
    "event_name": "push",
    "environment": "production",
    "workflow": "deploy-production",
    "workflow_ref": "acme-corp@1042/payments-api@88317/.github/workflows/deploy.yml@refs/heads/main",
    "workflow_sha": "9a1f6c04c0f1b1b5f6d3d9d70a4b3e8f2c7d5a11",
    "job_workflow_ref": "acme-corp@1042/payments-api@88317/.github/workflows/deploy.yml@refs/heads/main",
    "job_workflow_sha": "9a1f6c04c0f1b1b5f6d3d9d70a4b3e8f2c7d5a11",
    "runner_environment": "self-hosted",
}


def _resolve_session(region: str) -> boto3.Session:
    """Prefer the PRIMARY profile (deploy shell) but fall back to ambient credentials."""
    try:
        candidate = boto3.Session(profile_name="PRIMARY", region_name=region)
        candidate.client("sts", region_name=region).get_caller_identity()
        return candidate
    except Exception:
        return boto3.Session(region_name=region)


def _outputs(session: boto3.Session, region: str) -> dict:
    cfn = session.client("cloudformation", region_name=region)
    stack = cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]
    return {o["OutputKey"]: o["OutputValue"] for o in stack.get("Outputs", [])}


def _clock(base_epoch: float):
    """Return a function producing `[HH:MM:SS]` stamps advancing from base_epoch."""
    state = {"t": base_epoch}

    def stamp(advance: float = 1.0) -> str:
        state["t"] += advance
        return dt.datetime.utcfromtimestamp(state["t"]).strftime("[%H:%M:%SZ]")

    return stamp


def _failing_run_log(
    account: str, run_id: str, run_number: str, base_epoch: float
) -> str:
    ts = _clock(base_epoch)
    role_arn = f"arn:aws:iam::{account}:role/acme-ci-github-deploy-role"
    lines = [
        f"{ts(0)} Runner name: 'codebuild-payments-api-gha-runner-{run_id}'",
        f"{ts()} Runner group name: 'acme-codebuild-runners'",
        f"{ts()} Machine name: 'runner-ip-10-42-3-118'",
        f"{ts()} Job: deploy-production  (run #{run_number}, attempt 1)",
        f"{ts()} Repository: acme-corp/payments-api",
        f"{ts()} Ref: refs/heads/main",
        f"{ts()} ##[group]Run actions/checkout@v4",
        f"{ts()} Syncing repository: acme-corp/payments-api",
        f"{ts()} ##[endgroup]",
        f"{ts()} ##[group]Run aws-actions/configure-aws-credentials@v4",
        f"{ts(0)}   with:",
        f"{ts(0)}     role-to-assume: {role_arn}",
        f"{ts(0)}     role-session-name: gha-payments-api-deploy",
        f"{ts(0)}     aws-region: us-east-1",
        f"{ts(0)}     audience: ***",
        f"{ts(0)}   env:",
        f"{ts(0)}     ACTIONS_ID_TOKEN_REQUEST_URL: ***",
        f"{ts()} ##[endgroup]",
        f"{ts()} id_token received (claim set masked in job logs)",
        f"{ts()} Assuming role with OIDC",
        f"{ts()} ##[error]Could not assume role with OIDC: Not authorized to perform sts:AssumeRoleWithWebIdentity",
        f"{ts(0)} ##[error]AccessDenied: Not authorized to perform sts:AssumeRoleWithWebIdentity",
        f"{ts(0)}   status code: 403, request id: 5f8b0f6c-9c1a-4a44-a3ef-{run_id}0ab2",
        f"{ts()} ##[error]Process completed with exit code 1.",
        f"{ts()} Cleaning up orphan processes",
        f"{ts()} Job deploy-production failed after 19s",
    ]
    return "\n".join(lines) + "\n"


def _passing_run_log(
    account: str,
    repository: str,
    role_name: str,
    run_id: str,
    run_number: str,
    job_name: str,
    session_name: str,
    subject: str,
    base_epoch: float,
) -> str:
    ts = _clock(base_epoch)
    role_arn = f"arn:aws:iam::{account}:role/{role_name}"
    lines = [
        f"{ts(0)} Runner name: 'codebuild-{repository.split('/')[1]}-gha-runner-{run_id}'",
        f"{ts()} Runner group name: 'acme-codebuild-runners'",
        f"{ts()} Job: {job_name}  (run #{run_number}, attempt 1)",
        f"{ts()} Repository: {repository}",
        f"{ts()} Ref: refs/heads/main",
        f"{ts()} ##[group]Run actions/checkout@v4",
        f"{ts()} ##[endgroup]",
        f"{ts()} ##[group]Run aws-actions/configure-aws-credentials@v4",
        f"{ts(0)}   with:",
        f"{ts(0)}     role-to-assume: {role_arn}",
        f"{ts(0)}     role-session-name: {session_name}",
        f"{ts(0)}     aws-region: us-east-1",
        f"{ts(0)}     audience: token.actions.githubusercontent.com",
        f"{ts()} ##[endgroup]",
        f"{ts()} Requesting an OIDC id_token for audience 'token.actions.githubusercontent.com'",
        f"{ts()} Assuming role with OIDC",
        f"{ts()} Authenticated as assumed role {role_name}/{session_name}",
        f"{ts()} (matched trust policy statement for subject prefix '{subject}')",
        f"{ts()} ##[group]Run make release",
        f"{ts()} docker build -t {repository.split('/')[1]}:$GITHUB_SHA .",
        f"{ts()} aws s3 cp dist/ s3://acme-ci-artifacts-{account}/deploy/{repository.split('/')[1]}/ --recursive",
        f"{ts()} ##[endgroup]",
        f"{ts()} Job {job_name} succeeded in 96s",
    ]
    return "\n".join(lines) + "\n"


PAYMENTS_WORKFLOW = """name: deploy-production

on:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: read

jobs:
  deploy-production:
    runs-on: codebuild-payments-api-gha-runner-${{ github.run_id }}-${{ github.run_attempt }}
    environment: production
    steps:
      - uses: actions/checkout@v4
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::ACCOUNT_ID:role/acme-ci-github-deploy-role
          role-session-name: gha-payments-api-deploy
          aws-region: us-east-1
          # organisation-wide default set in acme-corp/.github: every workflow requests
          # the GitHub-native audience rather than sts.amazonaws.com
          audience: token.actions.githubusercontent.com
      - name: Build and push image
        run: make release
"""

LEGACY_WORKFLOW = """name: deploy-production

on:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: read

jobs:
  deploy-production:
    runs-on: codebuild-legacy-service-gha-runner-${{ github.run_id }}-${{ github.run_attempt }}
    environment: production
    steps:
      - uses: actions/checkout@v4
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::ACCOUNT_ID:role/acme-ci-github-deploy-role
          role-session-name: gha-legacy-service-deploy
          aws-region: us-east-1
          audience: token.actions.githubusercontent.com
      - name: Build and push image
        run: make release
"""


def run(session: Optional[boto3.Session] = None, region: str = REGION, **kwargs):
    if session is None:
        session = _resolve_session(region)

    account = session.client("sts", region_name=region).get_caller_identity()["Account"]
    out = _outputs(session, region)
    bucket = out["ArtifactBucketName"]
    s3 = session.client("s3", region_name=region)

    now = time.time()

    objects: dict[str, bytes] = {}

    # --- archived GitHub Actions job logs -------------------------------------
    objects[out["PaymentsRunLogKey"]] = _failing_run_log(
        account, "4471", "112", now - 2 * 3600
    ).encode()
    objects["ci-runs/payments-api/run-4470/deploy-production.log"] = _failing_run_log(
        account, "4470", "111", now - 26 * 3600
    ).encode()
    objects["ci-runs/payments-api/run-4468/deploy-production.log"] = _failing_run_log(
        account, "4468", "110", now - 50 * 3600
    ).encode()
    objects[out["LegacyRunLogKey"]] = _passing_run_log(
        account,
        "acme-corp/legacy-service",
        "acme-ci-github-deploy-role",
        "8812",
        "907",
        "deploy-production",
        "gha-legacy-service-deploy",
        "repo:acme-corp/legacy-service",
        now - 5 * 3600,
    ).encode()
    objects[out["StagingRunLogKey"]] = _passing_run_log(
        account,
        "acme-corp/payments-api-staging",
        "acme-ci-github-deploy-role-staging",
        "311",
        "58",
        "deploy-staging",
        "gha-payments-api-staging",
        "repo:acme-corp@1042/payments-api-staging@88931",
        now - 3 * 3600,
    ).encode()

    # --- workflow definitions -------------------------------------------------
    objects["ci-config/payments-api/.github/workflows/deploy.yml"] = (
        PAYMENTS_WORKFLOW.replace("ACCOUNT_ID", account).encode()
    )
    objects["ci-config/legacy-service/.github/workflows/deploy.yml"] = (
        LEGACY_WORKFLOW.replace("ACCOUNT_ID", account).encode()
    )

    # --- published deploy artifacts (legacy pipeline is healthy) --------------
    tarball = io.BytesIO()
    with gzip.GzipFile(fileobj=tarball, mode="wb", mtime=0) as gz:
        gz.write(b"legacy-service release 1.9.4\nbuild=907\ncommit=4c2b7de9\n")
    objects["deploy/legacy-service/legacy-service-1.9.4.tar.gz"] = tarball.getvalue()
    objects["deploy/legacy-service/manifest.json"] = json.dumps(
        {
            "service": "legacy-service",
            "version": "1.9.4",
            "run_id": "8812",
            "published_by": "arn:aws:sts::%s:assumed-role/acme-ci-github-deploy-role/gha-legacy-service-deploy"
            % account,
        },
        indent=2,
    ).encode()
    objects["deploy/payments-api-staging/manifest.json"] = json.dumps(
        {
            "service": "payments-api",
            "channel": "staging",
            "version": "2.4.0-rc7",
            "run_id": "311",
        },
        indent=2,
    ).encode()
    objects["deploy/payments-api/PENDING.txt"] = (
        "No production artifact has ever been published for payments-api.\n"
        "Every deploy-production run failed before the build step.\n"
    ).encode()

    for key, body in objects.items():
        s3.put_object(Bucket=bucket, Key=key, Body=body, ContentType="text/plain")
        print(f"seeded s3://{bucket}/{key} ({len(body)} bytes)")

    # --- claim-set template consumed by the runner to mint fresh id_tokens ---
    ssm = session.client("ssm", region_name=region)
    ssm.put_parameter(
        Name=PAYMENTS_CLAIMS_TEMPLATE_PARAM,
        Value=json.dumps(PAYMENTS_API_CLAIMS_BASE, separators=(",", ":")),
        Type="String",
        Overwrite=True,
    )
    print(f"seeded ssm {PAYMENTS_CLAIMS_TEMPLATE_PARAM}")

    print(f"setup complete: {len(objects)} objects in {bucket}")


if __name__ == "__main__":
    run()
