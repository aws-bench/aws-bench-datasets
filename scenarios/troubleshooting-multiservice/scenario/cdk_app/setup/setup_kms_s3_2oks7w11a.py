"""Setup script for stack s3-2oks7w11a (troubleshooting-multiservice).
Adds data-plane principals (Workhorse, basalt, onyx) to the Quartz KMS key
policy. CDK cannot include these in the key policy at creation time without
circular dependencies or invalid-principal errors on fresh accounts.
Legacy roles are intentionally omitted (that's the test case bug).
Idempotent — skips if the data-plane statement already exists.
"""

import json
import sys

import boto3
from botocore.config import Config

config = Config(connect_timeout=5, read_timeout=60)
STACK_NAME = "troubleshooting-multiservice-s3-2oks7w11a-us-east-1"
REGION = "us-east-1"


def run(session: boto3.Session = None, region: str = REGION, **parameters):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY", region_name=region)

    account_id = session.client("sts").get_caller_identity()["Account"]
    kms = session.client("kms", config=config, region_name=region)

    # Find the key by alias
    alias_name = f"alias/quartz-{account_id}-{region}"
    try:
        response = kms.describe_key(KeyId=alias_name)
        key_id = response["KeyMetadata"]["KeyId"]
    except Exception as e:
        raise RuntimeError(f"Key alias {alias_name} not found: {e}")

    # Get current policy
    policy_str = kms.get_key_policy(KeyId=key_id, PolicyName="default")["Policy"]
    policy = json.loads(policy_str)

    # Role ARNs to add
    role_arns = [
        f"arn:aws:iam::{account_id}:role/Quartz-Workhorse-{account_id}-{region}",
        f"arn:aws:iam::{account_id}:role/external-access-QuartzStream-basalt-{account_id}-{region}",
        f"arn:aws:iam::{account_id}:role/external-access-QuartzStream-onyx-{account_id}-{region}",
    ]

    # Idempotent: check if data-plane statement already exists
    data_plane_sid = "QuartzDataPlaneAccess"
    existing = [s for s in policy["Statement"] if s.get("Sid") == data_plane_sid]
    if existing:
        print(f"Data-plane statement already present in key {key_id}, skipping.")
        return

    policy["Statement"].append(
        {
            "Sid": data_plane_sid,
            "Effect": "Allow",
            "Principal": {"AWS": role_arns},
            "Action": ["kms:Decrypt", "kms:GenerateDataKey"],
            "Resource": "*",
        }
    )
    kms.put_key_policy(KeyId=key_id, PolicyName="default", Policy=json.dumps(policy))
    print(f"Added data-plane statement to key {key_id} for {len(role_arns)} roles.")


if __name__ == "__main__":
    try:
        run()
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
