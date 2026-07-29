#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

STACKS=$(aws cloudformation list-stacks --region "$REGION" \
    --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
    --query "StackSummaries[].StackName" --output text)

WITH_BUCKETS=""
REGULAR=""
VECTOR=""
TABLE=""

for NAME in $STACKS; do
    TYPES=$(aws cloudformation list-stack-resources --region "$REGION" \
        --stack-name "$NAME" \
        --query "StackResourceSummaries[].ResourceType" --output text)
    HAS=""
    if printf '%s\n' "$TYPES" | grep -qw "AWS::S3::Bucket"; then
        REGULAR="$REGULAR$NAME"$'\n'
        HAS=1
    fi
    if printf '%s\n' "$TYPES" | grep -qw "AWS::S3Vectors::VectorBucket"; then
        VECTOR="$VECTOR$NAME"$'\n'
        HAS=1
    fi
    if printf '%s\n' "$TYPES" | grep -qw "AWS::S3Tables::TableBucket"; then
        TABLE="$TABLE$NAME"$'\n'
        HAS=1
    fi
    if [ -n "$HAS" ]; then
        WITH_BUCKETS="$WITH_BUCKETS$NAME"$'\n'
    fi
done

TOTAL=$(printf '%s' "$WITH_BUCKETS" | grep -c . || true)
REGULAR_COUNT=$(printf '%s' "$REGULAR" | grep -c . || true)
VECTOR_LIST=$(printf '%s' "$VECTOR" | grep . | sort | paste -sd ',' - | sed 's/,/, /g' || true)
TABLE_LIST=$(printf '%s' "$TABLE" | grep . | sort | paste -sd ',' - | sed 's/,/, /g' || true)
VECTOR_LIST="${VECTOR_LIST:-(none)}"
TABLE_LIST="${TABLE_LIST:-(none)}"

cat > "$OUT" <<EOF
In ${REGION}, ${TOTAL} active CloudFormation stacks declare an S3 bucket resource. Of those, ${REGULAR_COUNT} contain a regular \`AWS::S3::Bucket\`. Vector buckets (\`AWS::S3Vectors::VectorBucket\`) are declared by these stacks: ${VECTOR_LIST}. Table buckets (\`AWS::S3Tables::TableBucket\`) are declared by these stacks: ${TABLE_LIST}.
EOF
