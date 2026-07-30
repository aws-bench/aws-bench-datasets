"""Shared data-plane reset for deploy-ec2-instance-with-ebs.

Finds any instances the EBS volume is attached to, detaches the volume,
and terminates those instances. This ensures the volume is in 'available'
state for the next trial run.

Imported and called by both pre_invoke and post_invoke. Config is read from environment variables.
Best-effort: returns a list of error strings rather than raising.
"""

import os
import time

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
VOLUME_ID = os.environ.get("VOLUME_ID", "")


def reset_data_plane(
    session: boto3.Session | None = None, region: str = REGION
) -> list[str]:
    """Detach the EBS volume and terminate any instance it was attached to.

    Returns a list of error strings (empty on success). Never raises for
    per-resource failures.
    """
    if not VOLUME_ID:
        return ["VOLUME_ID not set; skipping reset"]

    if session is None:
        session = boto3.Session(region_name=region)
    ec2 = session.client("ec2", region_name=region)
    errors: list[str] = []

    # Describe the volume to find attachments
    try:
        resp = ec2.describe_volumes(VolumeIds=[VOLUME_ID])
        volumes = resp.get("Volumes", [])
        if not volumes:
            return [f"Volume {VOLUME_ID} not found"]
        volume = volumes[0]
    except ClientError as e:
        return [f"describe_volumes {VOLUME_ID}: {e}"]

    attachments = volume.get("Attachments", [])
    instance_ids: list[str] = []

    for attachment in attachments:
        instance_id = attachment.get("InstanceId", "")
        state = attachment.get("State", "")
        if not instance_id:
            continue
        instance_ids.append(instance_id)

        # Detach the volume if it's attached
        if state in ("attached", "attaching"):
            try:
                ec2.detach_volume(
                    VolumeId=VOLUME_ID,
                    InstanceId=instance_id,
                    Force=True,
                )
            except ClientError as e:
                errors.append(f"detach_volume {VOLUME_ID} from {instance_id}: {e}")

    # Terminate instances the volume was attached to
    if instance_ids:
        try:
            ec2.terminate_instances(InstanceIds=instance_ids)
        except ClientError as e:
            errors.append(f"terminate_instances {instance_ids}: {e}")

    # Wait for volume to become available
    if attachments:
        for _ in range(30):  # up to ~60 seconds
            try:
                resp = ec2.describe_volumes(VolumeIds=[VOLUME_ID])
                state = resp["Volumes"][0]["State"]
                if state == "available":
                    break
            except ClientError:
                break
            time.sleep(2)

    return errors
