"""Data-plane reset for bedrock-distill-from-s3-jsonl.

Empties the versioned training and output buckets (all versions and
delete-markers) and re-puts the seeded JSONL training object. Best-effort:
returns a list of error strings rather than raising.
"""

import json
import mimetypes
import os

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
BUCKET_NAME = os.environ.get("TRAINING_BUCKET_NAME", "")
OUTPUT_BUCKET_NAME = os.environ.get("OUTPUT_BUCKET_NAME", "")

# Baseline training data in the Bedrock distillation format
# (bedrock-conversation-2024, prompt-only — the teacher model generates the
# completions). Each line carries a `messages` field as the verifier expects.
_PROMPTS = [
    "What is artificial intelligence?",
    "Explain cloud computing in one sentence.",
    "What is a neural network?",
    "Define machine learning.",
    "What is Amazon S3?",
    "Summarize what an API does.",
    "What is a container?",
    "Explain network latency.",
    "What is a database index?",
    "Describe serverless computing.",
]

_TRAINING_JSONL = (
    "\n".join(
        json.dumps(
            {
                "schemaVersion": "bedrock-conversation-2024",
                "system": [{"text": "You are a helpful assistant."}],
                "messages": [{"role": "user", "content": [{"text": prompt}]}],
            }
        )
        for prompt in _PROMPTS
    )
    + "\n"
)

# Baseline training objects.
OBJECTS: dict[str, str] = {
    "training-data.jsonl": _TRAINING_JSONL,
}


def _empty(s3, bucket: str, errors: list[str]) -> None:
    """Delete all versions and delete-markers in the versioned bucket."""
    try:
        paginator = s3.get_paginator("list_object_versions")
        for page in paginator.paginate(Bucket=bucket):
            to_delete = [
                {"Key": v["Key"], "VersionId": v["VersionId"]}
                for v in page.get("Versions", []) + page.get("DeleteMarkers", [])
            ]
            if to_delete:
                s3.delete_objects(Bucket=bucket, Delete={"Objects": to_delete})
    except ClientError as e:
        errors.append(f"empty {bucket}: {e}")


def _put(s3, bucket: str, key: str, body: str, errors: list[str]) -> None:
    """Re-put a baseline object with a best-effort Content-Type."""
    ctype = mimetypes.guess_type(key)[0] or "application/octet-stream"
    try:
        s3.put_object(
            Bucket=bucket, Key=key, Body=body.encode("utf-8"), ContentType=ctype
        )
    except ClientError as e:
        errors.append(f"put {bucket}/{key}: {e}")


def reset_data_plane(
    session: boto3.Session | None = None, region: str = REGION
) -> list[str]:
    """Re-establish the seeded S3 training data to its baseline."""
    if not BUCKET_NAME:
        return []
    if session is None:
        session = boto3.Session(region_name=region)
    s3 = session.client("s3", region_name=region)
    errors: list[str] = []
    _empty(s3, BUCKET_NAME, errors)
    if OUTPUT_BUCKET_NAME:
        _empty(s3, OUTPUT_BUCKET_NAME, errors)
    for key, body in OBJECTS.items():
        _put(s3, BUCKET_NAME, key, body, errors)
    return errors
