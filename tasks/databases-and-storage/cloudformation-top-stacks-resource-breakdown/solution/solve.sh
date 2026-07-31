#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

python3 - "$REGION" > "$OUT" <<'PY'
import sys
from collections import Counter

import boto3

region = sys.argv[1]
PREFIX = "databases-and-storage"

cfn = boto3.client("cloudformation", region_name=region)

stacks = []
for page in cfn.get_paginator("list_stacks").paginate(
    StackStatusFilter=["CREATE_COMPLETE", "UPDATE_COMPLETE"]
):
    for s in page["StackSummaries"]:
        if s["StackName"].startswith(PREFIX):
            stacks.append(s["StackName"])

stack_data = {}
res_paginator = cfn.get_paginator("list_stack_resources")
for name in stacks:
    types = Counter()
    for page in res_paginator.paginate(StackName=name):
        for r in page["StackResourceSummaries"]:
            types[r["ResourceType"]] += 1
    stack_data[name] = (sum(types.values()), types)

ranked = sorted(stack_data.items(), key=lambda x: (-x[1][0], x[0]))[:3]

parts = []
for i, (name, (total, types)) in enumerate(ranked, 1):
    sorted_types = sorted(types.items(), key=lambda x: (-x[1], x[0]))[:3]
    top_types = "; ".join(f"{t}: {c}" for t, c in sorted_types)
    parts.append(f"{i}) {name} with {total} resources ({top_types})")

print("The top 3 stacks by resource count are: " + ", ".join(parts) + ".")
PY
