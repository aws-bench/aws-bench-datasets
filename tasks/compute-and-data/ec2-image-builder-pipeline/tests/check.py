"""Programmatic verifier for ec2-image-builder-pipeline.

Re-implements aws-bench-datasets/src/aws_bench_datasets/mutation_scripts/e4f5g6h7-i8j9-k012-l3m4-n5o6p7q8r9s0/validate.py.

The agent reports the Image Pipeline ARN via agent-output.json.
Verifier confirms the pipeline exists, its last run isn't FAILED, and
its distribution config covers `us-east-2`.
"""

import json
import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    AGENT_OUTPUT = {}

REQUIRED_OUTPUT_KEYS = ("image_pipeline_arn",)
PIPELINE_ARN = AGENT_OUTPUT.get("image_pipeline_arn") or ""

REQUIRED_DISTRIBUTION_REGION = "us-east-2"


def _imagebuilder():
    return boto3.client("imagebuilder", region_name=REGION)


def _get_pipeline() -> dict | None:
    """Fetch the pipeline. Returns the imagePipeline dict, or None on failure."""
    if not PIPELINE_ARN:
        return None
    try:
        resp = _imagebuilder().get_image_pipeline(imagePipelineArn=PIPELINE_ARN)
    except ClientError:
        return None
    return resp.get("imagePipeline") or None


@criterion(description="agent wrote agent-output.json with all required keys")
def output_contract_followed(workspace: Path) -> bool:
    return bool(AGENT_OUTPUT) and all(k in AGENT_OUTPUT for k in REQUIRED_OUTPUT_KEYS)


@criterion(
    description="reported Image Pipeline exists, was executed, and last run is not FAILED"
)
def pipeline_runs_clean(workspace: Path) -> bool:
    """A null lastRunStatus (created but never run) fails; any non-FAILED
    status (AVAILABLE, BUILDING, PENDING) passes — image builds run for
    20-40min and we don't gate completion.
    """
    pipeline = _get_pipeline()
    if pipeline is None:
        return False
    status = pipeline.get("lastRunStatus")
    return bool(status) and status != "FAILED"


@criterion(
    description=f"pipeline's distribution configuration includes region {REQUIRED_DISTRIBUTION_REGION!r}"
)
def distribution_targets_us_east_2(workspace: Path) -> bool:
    pipeline = _get_pipeline()
    if pipeline is None:
        return False
    dist_arn = pipeline.get("distributionConfigurationArn")
    if not dist_arn:
        return False
    try:
        resp = _imagebuilder().get_distribution_configuration(
            distributionConfigurationArn=dist_arn
        )
    except ClientError:
        return False
    distributions = (resp.get("distributionConfiguration") or {}).get(
        "distributions"
    ) or []
    return any(d.get("region") == REQUIRED_DISTRIBUTION_REGION for d in distributions)


@criterion(
    description="a launch template exists that references an AMI produced by the pipeline"
)
def launch_template_uses_pipeline_ami(workspace: Path) -> bool:
    """The instruction says 'create a launch template that uses this new AMI.'
    We verify: at least one launch template in the account has an ImageId
    that matches an AMI produced by the agent's pipeline.
    """
    pipeline = _get_pipeline()
    if pipeline is None:
        return False
    pipeline_arn = PIPELINE_ARN
    if not pipeline_arn:
        return False

    # Collect AMI IDs produced by this specific pipeline
    try:
        img_resp = _imagebuilder().list_image_pipeline_images(
            imagePipelineArn=pipeline_arn
        )
    except ClientError:
        return False

    pipeline_ami_ids: set[str] = set()
    for img_summary in img_resp.get("imageSummaryList") or []:
        for ami in (img_summary.get("outputResources") or {}).get("amis") or []:
            ami_id = ami.get("image")
            if ami_id:
                pipeline_ami_ids.add(ami_id)

    if not pipeline_ami_ids:
        return False

    # Check all launch templates for one that references a pipeline-produced AMI
    ec2 = boto3.client("ec2", region_name=REGION)
    try:
        lt_resp = ec2.describe_launch_templates()
    except ClientError:
        return False

    for lt in lt_resp.get("LaunchTemplates") or []:
        lt_id = lt.get("LaunchTemplateId")
        if not lt_id:
            continue
        try:
            ver_resp = ec2.describe_launch_template_versions(
                LaunchTemplateId=lt_id, Versions=["$Default"]
            )
        except ClientError:
            continue
        versions = ver_resp.get("LaunchTemplateVersions") or []
        if not versions:
            continue
        launch_data = versions[0].get("LaunchTemplateData") or {}
        image_id = launch_data.get("ImageId")
        if image_id and image_id in pipeline_ami_ids:
            return True

    return False
