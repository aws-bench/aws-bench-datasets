"""Shared data-plane reset for dynamodb-strip-ec2-fields-from-prod.

Deletes all items in the DynamoDB table and re-seeds the exact 100
records that the CDK stack creates. This ensures each trial starts from
the same baseline regardless of what the agent did in a prior run.

The seeding logic mirrors dynamodb_fyu89ikhg.ts exactly — same seeded
RNG, same record IDs, same field names and values.

Imported and called by both pre_invoke and post_invoke. Config is read from environment variables.
Best-effort: returns a list of error strings rather than raising.
"""

import os

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
TABLE_NAME = os.environ.get("EXPECTED_TABLE", "")

TARGET_RECORD_IDS = {
    "PROD-EC2-015",
    "PROD-EC2-027",
    "PROD-EC2-041",
    "PROD-EC2-063",
    "PROD-EC2-078",
    "PROD-EC2-084",
    "PROD-EC2-091",
}


class _SeededRandom:
    """Mirrors the SeededRandom class in the CDK stack."""

    def __init__(self, seed: int):
        self._seed = seed

    def next(self) -> float:
        self._seed = (self._seed * 9301 + 49297) % 233280
        return self._seed / 233280


def _generate_seed_items() -> list[dict]:
    """Generate the exact 100 items the CDK stack seeds."""
    rng = _SeededRandom(12345)
    items: list[dict] = []

    environments = ["terraform", "cloudformation", "manual"]
    instance_types = ["t3.micro", "t3.small", "t3.medium"]
    instance_types_2 = ["t3.micro", "t3.small"]

    for i in range(1, 101):
        record_id = f"PROD-SRV-{i:03d}"
        ec2_record_id = record_id.replace("SRV", "EC2")
        is_target = ec2_record_id in TARGET_RECORD_IDS

        item: dict = {
            "id": ec2_record_id if is_target else record_id,
            "name": f"production-server-{i}" if is_target else f"server-{i}",
            "environment": "production" if i % 3 == 0 else "staging",
            "created_by": environments[i % 3],
        }

        if is_target:
            instance_id = hex(int(rng.next() * 1000000000000000))[2:].zfill(17)
            item["ec2_instance_id"] = f"i-{instance_id}"
            item["ec2_instance_type"] = instance_types[i % 3]
        else:
            instance_id = hex(int(rng.next() * 1000000000000000))[2:].zfill(17)
            item["instance_id"] = f"i-{instance_id}"
            item["instance_type"] = instance_types[i % 3]
            item["aws_instance_id"] = f"i-{instance_id[:10]}"
            item["compute_instance_type"] = instance_types_2[i % 2]

        items.append(item)

    return items


def reset_data_plane(
    session: boto3.Session | None = None, region: str = REGION
) -> list[str]:
    """Delete all items and re-seed the table with the CDK baseline data.

    Returns a list of error strings (empty on success). Never raises for
    per-resource failures.
    """
    if not TABLE_NAME:
        return ["EXPECTED_TABLE not set; skipping reset"]

    if session is None:
        session = boto3.Session(region_name=region)
    dynamodb = session.resource("dynamodb", region_name=region)
    table = dynamodb.Table(TABLE_NAME)
    errors: list[str] = []

    # Delete all existing items
    try:
        scan_kwargs: dict = {"ProjectionExpression": "id"}
        while True:
            resp = table.scan(**scan_kwargs)
            items = resp.get("Items", [])
            with table.batch_writer() as batch:
                for item in items:
                    batch.delete_item(Key={"id": item["id"]})
            if not resp.get("LastEvaluatedKey"):
                break
            scan_kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    except ClientError as e:
        errors.append(f"delete_all_items: {e}")
        return errors

    # Re-seed with exact CDK baseline data
    seed_items = _generate_seed_items()
    try:
        with table.batch_writer() as batch:
            for item in seed_items:
                batch.put_item(Item=item)
    except ClientError as e:
        errors.append(f"seed_items: {e}")

    return errors
