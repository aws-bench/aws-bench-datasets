"""Shared data-plane reset for ec2-image-builder-pipeline.

Deletes all EC2 Image Builder resources in the account/region:
pipelines, images, recipes, components, infrastructure configs,
distribution configs, and associated launch templates and AMIs.

No CDK stacks or other tasks use Image Builder in this scenario,
so a broad deletion approach is safe.

Imported and called by both pre_invoke and post_invoke. Config is read from environment variables.
Best-effort: returns a list of error strings rather than raising.
"""

import os

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")


def _delete_all_pipelines(ib, errors: list[str]) -> None:
    """Delete all image pipelines."""
    try:
        paginator = ib.get_paginator("list_image_pipelines")
        for page in paginator.paginate():
            for pipeline in page.get("imagePipelineList", []):
                try:
                    ib.delete_image_pipeline(imagePipelineArn=pipeline["arn"])
                except ClientError as e:
                    errors.append(f"delete_image_pipeline {pipeline['arn']}: {e}")
    except ClientError as e:
        errors.append(f"list_image_pipelines: {e}")


def _cancel_and_delete_images(ib, errors: list[str]) -> None:
    """Cancel in-progress builds and delete all images."""
    try:
        paginator = ib.get_paginator("list_images")
        for page in paginator.paginate(owner="Self"):
            for image in page.get("imageVersionList", []):
                image_arn = image["arn"]
                # List all build versions of this image
                try:
                    build_paginator = ib.get_paginator("list_image_build_versions")
                    for build_page in build_paginator.paginate(
                        imageVersionArn=image_arn
                    ):
                        for build in build_page.get("imageSummaryList", []):
                            build_arn = build["arn"]
                            state = build.get("state", {}).get("status", "")
                            if state in ("BUILDING", "TESTING", "DISTRIBUTING"):
                                try:
                                    ib.cancel_image_creation(
                                        imageBuildVersionArn=build_arn
                                    )
                                except ClientError:
                                    pass
                            try:
                                ib.delete_image(imageBuildVersionArn=build_arn)
                            except ClientError as e:
                                errors.append(f"delete_image {build_arn}: {e}")
                except ClientError as e:
                    errors.append(f"list_image_build_versions {image_arn}: {e}")
    except ClientError as e:
        errors.append(f"list_images: {e}")


def _delete_all_recipes(ib, errors: list[str]) -> None:
    """Delete all image recipes."""
    try:
        paginator = ib.get_paginator("list_image_recipes")
        for page in paginator.paginate(owner="Self"):
            for recipe in page.get("imageRecipeSummaryList", []):
                try:
                    ib.delete_image_recipe(imageRecipeArn=recipe["arn"])
                except ClientError as e:
                    errors.append(f"delete_image_recipe {recipe['arn']}: {e}")
    except ClientError as e:
        errors.append(f"list_image_recipes: {e}")


def _delete_all_components(ib, errors: list[str]) -> None:
    """Delete all owned components."""
    try:
        paginator = ib.get_paginator("list_components")
        for page in paginator.paginate(owner="Self"):
            for component in page.get("componentVersionList", []):
                # List build versions to get deletable ARNs
                try:
                    bv_paginator = ib.get_paginator("list_component_build_versions")
                    for bv_page in bv_paginator.paginate(
                        componentVersionArn=component["arn"]
                    ):
                        for bv in bv_page.get("componentSummaryList", []):
                            try:
                                ib.delete_component(componentBuildVersionArn=bv["arn"])
                            except ClientError as e:
                                errors.append(f"delete_component {bv['arn']}: {e}")
                except ClientError as e:
                    errors.append(
                        f"list_component_build_versions {component['arn']}: {e}"
                    )
    except ClientError as e:
        errors.append(f"list_components: {e}")


def _delete_all_infra_configs(ib, errors: list[str]) -> None:
    """Delete all infrastructure configurations."""
    try:
        paginator = ib.get_paginator("list_infrastructure_configurations")
        for page in paginator.paginate():
            for config in page.get("infrastructureConfigurationSummaryList", []):
                try:
                    ib.delete_infrastructure_configuration(
                        infrastructureConfigurationArn=config["arn"]
                    )
                except ClientError as e:
                    errors.append(
                        f"delete_infrastructure_configuration {config['arn']}: {e}"
                    )
    except ClientError as e:
        errors.append(f"list_infrastructure_configurations: {e}")


def _delete_all_distribution_configs(ib, errors: list[str]) -> None:
    """Delete all distribution configurations."""
    try:
        paginator = ib.get_paginator("list_distribution_configurations")
        for page in paginator.paginate():
            for config in page.get("distributionConfigurationSummaryList", []):
                try:
                    ib.delete_distribution_configuration(
                        distributionConfigurationArn=config["arn"]
                    )
                except ClientError as e:
                    errors.append(
                        f"delete_distribution_configuration {config['arn']}: {e}"
                    )
    except ClientError as e:
        errors.append(f"list_distribution_configurations: {e}")


def _deregister_amis_and_delete_snapshots(session, ec2, errors: list[str]) -> None:
    """Deregister AMIs created by Image Builder and delete their snapshots."""
    try:
        resp = ec2.describe_images(
            Owners=["self"],
            Filters=[
                {"Name": "tag-key", "Values": ["CreatedBy"]},
            ],
        )
        for image in resp.get("Images", []):
            # Check if created by Image Builder
            tags = {t["Key"]: t["Value"] for t in image.get("Tags", [])}
            if "EC2 Image Builder" not in tags.get("CreatedBy", ""):
                continue

            image_id = image["ImageId"]
            # Collect snapshot IDs before deregistering
            snapshot_ids = []
            for bdm in image.get("BlockDeviceMappings", []):
                ebs = bdm.get("Ebs", {})
                if ebs.get("SnapshotId"):
                    snapshot_ids.append(ebs["SnapshotId"])

            try:
                ec2.deregister_image(ImageId=image_id)
            except ClientError as e:
                errors.append(f"deregister_image {image_id}: {e}")
                continue

            for snap_id in snapshot_ids:
                try:
                    ec2.delete_snapshot(SnapshotId=snap_id)
                except ClientError as e:
                    errors.append(f"delete_snapshot {snap_id}: {e}")
    except ClientError as e:
        errors.append(f"describe_images: {e}")

    # Also check us-east-2 (distribution target)
    try:
        ec2_east2 = session.client("ec2", region_name="us-east-2")
        resp = ec2_east2.describe_images(
            Owners=["self"],
            Filters=[{"Name": "tag-key", "Values": ["CreatedBy"]}],
        )
        for image in resp.get("Images", []):
            tags = {t["Key"]: t["Value"] for t in image.get("Tags", [])}
            if "EC2 Image Builder" not in tags.get("CreatedBy", ""):
                continue

            image_id = image["ImageId"]
            snapshot_ids = []
            for bdm in image.get("BlockDeviceMappings", []):
                ebs = bdm.get("Ebs", {})
                if ebs.get("SnapshotId"):
                    snapshot_ids.append(ebs["SnapshotId"])

            try:
                ec2_east2.deregister_image(ImageId=image_id)
            except ClientError as e:
                errors.append(f"deregister_image(us-east-2) {image_id}: {e}")
                continue

            for snap_id in snapshot_ids:
                try:
                    ec2_east2.delete_snapshot(SnapshotId=snap_id)
                except ClientError as e:
                    errors.append(f"delete_snapshot(us-east-2) {snap_id}: {e}")
    except ClientError as e:
        errors.append(f"describe_images(us-east-2): {e}")


def _delete_launch_templates(ec2, errors: list[str]) -> None:
    """Delete launch templates created by Image Builder."""
    try:
        paginator = ec2.get_paginator("describe_launch_templates")
        for page in paginator.paginate(
            Filters=[{"Name": "tag:CreatedBy", "Values": ["EC2 Image Builder"]}]
        ):
            for lt in page.get("LaunchTemplates", []):
                lt_id = lt["LaunchTemplateId"]
                try:
                    ec2.delete_launch_template(LaunchTemplateId=lt_id)
                except ClientError as e:
                    errors.append(f"delete_launch_template {lt_id}: {e}")
    except ClientError as e:
        errors.append(f"describe_launch_templates: {e}")


def reset_data_plane(
    session: boto3.Session | None = None, region: str = REGION
) -> list[str]:
    """Delete all Image Builder resources, associated AMIs, and launch
    templates.

    Deletion order respects dependencies:
    1. Pipelines (depend on recipes, infra configs, dist configs)
    2. Images (depend on recipes)
    3. Recipes (depend on components)
    4. Components
    5. Infrastructure configurations
    6. Distribution configurations
    7. AMIs and snapshots (in us-east-1 and us-east-2)
    8. Launch templates

    Returns a list of error strings (empty on success). Never raises for
    per-resource failures.
    """
    if session is None:
        session = boto3.Session(region_name=region)
    ib = session.client("imagebuilder", region_name=region)
    ec2 = session.client("ec2", region_name=region)
    errors: list[str] = []

    _delete_all_pipelines(ib, errors)
    _cancel_and_delete_images(ib, errors)
    _delete_all_recipes(ib, errors)
    _delete_all_components(ib, errors)
    _delete_all_infra_configs(ib, errors)
    _delete_all_distribution_configs(ib, errors)
    _deregister_amis_and_delete_snapshots(session, ec2, errors)
    _delete_launch_templates(ec2, errors)

    return errors
