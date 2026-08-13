"""Programmatic verifier for ec2-image-builder-pipeline.

Re-implements aws-bench-datasets/src/aws_bench_datasets/mutation_scripts/e4f5g6h7-i8j9-k012-l3m4-n5o6p7q8r9s0/validate.py.

The agent reports the Image Pipeline ARN via agent-output.json.
Verifier confirms the pipeline exists in the us-east-1 build region, its
last run isn't FAILED, and its distribution config copies the AMI to
`us-east-2`.

The pipeline itself must live in us-east-1: the task builds there and
distributes (copies) the AMI to us-east-2, so a pipeline built directly
in us-east-2 subverts the cross-region-distribution intent and also leaks
resources the reset (us-east-1 only) can't clean up. AMIs and launch
templates are still scanned across all scenario Regions, since the AMI
legitimately lands in us-east-2.
"""

import json
import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

SCENARIO_REGIONS = [
    r.strip() for r in os.environ.get("SCENARIO_REGIONS", "us-east-1").split(",")
]
REGION = SCENARIO_REGIONS[0]  # Primary region for backwards compat
BUILD_REGION = "us-east-1"  # The pipeline must be built here (see module docstring)

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    AGENT_OUTPUT = {}

REQUIRED_OUTPUT_KEYS = ("image_pipeline_arn",)
PIPELINE_ARN = AGENT_OUTPUT.get("image_pipeline_arn") or ""

REQUIRED_DISTRIBUTION_REGION = "us-east-2"


def _imagebuilder(region=None):
    return boto3.client("imagebuilder", region_name=region or REGION)


def _get_pipeline() -> dict | None:
    """Fetch the pipeline from the us-east-1 build region.

    Returns the imagePipeline dict, or None if the pipeline does not exist
    in us-east-1 (a pipeline built in another Region does not satisfy the
    task).
    """
    if not PIPELINE_ARN:
        return None
    try:
        resp = _imagebuilder(BUILD_REGION).get_image_pipeline(
            imagePipelineArn=PIPELINE_ARN
        )
    except ClientError:
        return None
    return resp.get("imagePipeline") or None


def _get_pipeline_region() -> str | None:
    """Return the build Region if the pipeline exists there, else None."""
    return BUILD_REGION if _get_pipeline() is not None else None


@criterion(description="agent wrote agent-output.json with all required keys")
def output_contract_followed(workspace: Path) -> bool:
    return bool(AGENT_OUTPUT) and all(k in AGENT_OUTPUT for k in REQUIRED_OUTPUT_KEYS)


@criterion(
    description="reported Image Pipeline exists in us-east-1, was executed, and last run is not FAILED"
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
    # Use the region where the pipeline was found
    pipeline_region = _get_pipeline_region()
    try:
        resp = _imagebuilder(pipeline_region).get_distribution_configuration(
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

    # Use the region where the pipeline was found
    pipeline_region = _get_pipeline_region()

    # Collect AMI IDs produced by this specific pipeline
    try:
        img_resp = _imagebuilder(pipeline_region).list_image_pipeline_images(
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

    # Check all launch templates across regions for one that references a pipeline-produced AMI
    for region in SCENARIO_REGIONS:
        ec2 = boto3.client("ec2", region_name=region)
        try:
            lt_resp = ec2.describe_launch_templates()
        except ClientError:
            continue

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
