"""Pre-invoke: count active CloudFormation stacks in us-east-1 whose stack
template references an S3 bucket resource (regular, vector, or table).

Classifies the buckets by S3 resource type:
  - AWS::S3::Bucket            -> regular
  - AWS::S3Vectors::Bucket     -> vector
  - AWS::S3Tables::Bucket      -> table

Emits the count and a per-type breakdown so the verifier reference can be
fully resolved.
"""

import json
import os
import sys
from collections import Counter

import boto3

RESULT_FILE = "/logs/pre_invoke/placeholder.json"

S3_RESOURCE_TYPES = {
    "AWS::S3::Bucket": "regular",
    "AWS::S3Vectors::VectorBucket": "vector",
    "AWS::S3Tables::TableBucket": "table",
}


def run(session=None, region="us-east-1", **parameters):
    if not session:
        session = boto3.Session(region_name=region)

    cfn = session.client("cloudformation", region_name=region)

    # List all active stacks. We include CREATE_COMPLETE and UPDATE_COMPLETE —
    # IN_PROGRESS / FAILED states are not "active" enough to count.
    stacks: list[str] = []
    for page in cfn.get_paginator("list_stacks").paginate(
        StackStatusFilter=["CREATE_COMPLETE", "UPDATE_COMPLETE"]
    ):
        stacks.extend(s["StackName"] for s in page["StackSummaries"])

    # For each stack, look at its resources and classify any S3 buckets.
    # A stack counts if it contains at least one S3 bucket resource of any kind.
    stacks_with_buckets: set[str] = set()
    per_type_stacks: dict[str, list[str]] = {v: [] for v in S3_RESOURCE_TYPES.values()}
    res_paginator = cfn.get_paginator("list_stack_resources")
    for name in stacks:
        kinds: set[str] = set()
        for page in res_paginator.paginate(StackName=name):
            for r in page["StackResourceSummaries"]:
                t = r["ResourceType"]
                if t in S3_RESOURCE_TYPES:
                    kinds.add(S3_RESOURCE_TYPES[t])
        if kinds:
            stacks_with_buckets.add(name)
            for k in kinds:
                per_type_stacks[k].append(name)

    total = len(stacks_with_buckets)
    regular = len(per_type_stacks["regular"])
    vector_stacks = sorted(per_type_stacks["vector"])
    table_stacks = sorted(per_type_stacks["table"])

    return {
        "00da49d8-TotalStacksWithS3": str(total),
        "00da49d8-RegularBucketStackCount": str(regular),
        "00da49d8-VectorBucketStacks": ", ".join(vector_stacks) or "(none)",
        "00da49d8-TableBucketStacks": ", ".join(table_stacks) or "(none)",
    }


if __name__ == "__main__":
    try:
        placeholders = run()
    except Exception as e:
        print(f"pre_invoke failed: {e}", file=sys.stderr)
        sys.exit(1)

    os.makedirs(os.path.dirname(RESULT_FILE), exist_ok=True)
    with open(RESULT_FILE, "w") as f:
        json.dump(placeholders, f, indent=2)
