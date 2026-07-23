"""Seed sample vectors into the first index so the task answer is non-trivial."""

import json
import os
import boto3

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
VECTOR_BUCKET_RAW = os.environ["EXPECTED_VECTOR_BUCKET"]
FIRST_INDEX_RAW = os.environ["EXPECTED_FIRST_INDEX"]

# Extract plain names from ARNs if needed
# VectorBucketName export may be ARN: arn:aws:s3vectors:region:account:bucket/name
if "arn:" in VECTOR_BUCKET_RAW:
    VECTOR_BUCKET = VECTOR_BUCKET_RAW.split("/")[-1]
else:
    VECTOR_BUCKET = VECTOR_BUCKET_RAW

# FirstVectorIndex export is ARN: arn:aws:s3vectors:region:account:bucket/bucket-name/index/index-name
if "arn:" in FIRST_INDEX_RAW:
    INDEX_NAME = FIRST_INDEX_RAW.split("/")[-1]
else:
    INDEX_NAME = FIRST_INDEX_RAW

s3v = boto3.client("s3vectors", region_name=REGION)

# Seed 3 sample vectors into the first index
vectors = [
    {
        "key": "doc-001",
        "data": {"float32": [0.1] * 123},
        "metadata": {"category": "science", "title": "Quantum Computing Basics"},
    },
    {
        "key": "doc-002",
        "data": {"float32": [0.2] * 123},
        "metadata": {"category": "engineering", "title": "Bridge Design Patterns"},
    },
    {
        "key": "doc-003",
        "data": {"float32": [0.3] * 123},
        "metadata": {"category": "science", "title": "Neural Network Architectures"},
    },
]

try:
    s3v.put_vectors(
        vectorBucketName=VECTOR_BUCKET,
        indexName=INDEX_NAME,
        vectors=vectors,
    )
    print(f"Seeded 3 vectors into index {INDEX_NAME} in bucket {VECTOR_BUCKET}")
except Exception as e:
    print(f"ERROR: failed to seed vectors: {e}")
    raise

# Write required placeholder.json
os.makedirs("/logs/pre_invoke", exist_ok=True)
with open("/logs/pre_invoke/placeholder.json", "w") as f:
    json.dump({}, f)
