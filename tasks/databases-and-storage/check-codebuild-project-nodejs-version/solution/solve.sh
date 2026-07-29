#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

BUILDSPEC=$(aws codebuild batch-get-projects --names "$PROJECT_NAME" --region "$REGION" \
    --query 'projects[0].source.buildspec' --output text)
NODE_VERSION=$(printf '%s' "$BUILDSPEC" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["phases"]["install"]["runtime-versions"]["nodejs"])')

cat > "$OUT" <<EOF
The Node.js version configured for the CodeBuild project ${PROJECT_NAME} is ${NODE_VERSION}.
EOF
