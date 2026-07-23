"""Pre-invoke: find the top 3 CloudFormation stacks (prefixed
with 'databases-and-storage') by resource count and break down their top 3 resource types."""

import json
import os
import sys
from collections import Counter

import boto3

RESULT_FILE = "/logs/pre_invoke/placeholder.json"

PREFIX = "databases-and-storage"
TOP_N_STACKS = 3
TOP_N_TYPES = 3


def run(session=None, region="us-east-1", **parameters):
    if not session:
        session = boto3.Session(region_name=region)

    cfn = session.client("cloudformation", region_name=region)

    # Step 1: List all active CloudFormation stacks whose name starts with "databases-and-storage"
    stacks: list[str] = []
    paginator = cfn.get_paginator("list_stacks")
    for page in paginator.paginate(
        StackStatusFilter=["CREATE_COMPLETE", "UPDATE_COMPLETE"]
    ):
        for s in page["StackSummaries"]:
            if s["StackName"].startswith(PREFIX):
                stacks.append(s["StackName"])

    # Step 2: For each matching stack, count total resources and tally by resource type
    stack_data: dict[str, tuple[int, Counter]] = {}
    res_paginator = cfn.get_paginator("list_stack_resources")
    for name in stacks:
        types: Counter = Counter()
        for page in res_paginator.paginate(StackName=name):
            for r in page["StackResourceSummaries"]:
                types[r["ResourceType"]] += 1
        stack_data[name] = (sum(types.values()), types)

    # Step 3: Rank stacks by total resource count (descending), breaking ties
    # by stack name (ascending), and take the top 3.
    ranked = sorted(stack_data.items(), key=lambda x: (-x[1][0], x[0]))[:TOP_N_STACKS]

    # Step 4: Build the placeholder values for the verifier template.
    # For each of the top 3 stacks, emit its name, total resource count,
    # and a semicolon-separated breakdown of the top 3 resource types with counts.
    # Ties on count are broken by resource-type name (ascending) so the order is
    # deterministic and the agent can reproduce it.
    vals: dict[str, str] = {}
    for i, (name, (total, types)) in enumerate(ranked, 1):
        vals[f"4dd10da5-Stack{i}Name"] = name
        vals[f"4dd10da5-Stack{i}Count"] = str(total)
        sorted_types = sorted(types.items(), key=lambda x: (-x[1], x[0]))[:TOP_N_TYPES]
        top_types = "; ".join(f"{t}: {c}" for t, c in sorted_types)
        vals[f"4dd10da5-Stack{i}TopTypes"] = top_types

    return vals


if __name__ == "__main__":
    try:
        placeholders = run()
    except Exception as e:
        print(f"pre_invoke failed: {e}", file=sys.stderr)
        sys.exit(1)

    # Write computed placeholder values to disk for the verifier to consume
    os.makedirs(os.path.dirname(RESULT_FILE), exist_ok=True)
    with open(RESULT_FILE, "w") as f:
        json.dump(placeholders, f, indent=2)
