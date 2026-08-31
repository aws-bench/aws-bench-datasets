#!/bin/bash
# S3 + CloudFront web-platform cleanup. `pre` runs before the shared `cdk destroy --all`, `post` after.
set -uo pipefail

PHASE="${1:?usage: $0 pre|post}"

export AWS_PROFILE=PRIMARY

REGION="us-east-1"
SUFFIX="uobyzx8z7"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")

SCENARIO_BUCKETS=()
if [ -n "$ACCOUNT" ]; then
    SCENARIO_BUCKETS=(
        "web-build-artifacts-${SUFFIX}-${ACCOUNT}"
        "mktg-site-origin-${SUFFIX}-${ACCOUNT}"
        "pw-alpha-origin-${SUFFIX}-${ACCOUNT}"
    )
fi

if [ "$PHASE" = "pre" ]; then
    echo "=== pre: clear resources that block stack deletion ==="
    # Empty first: the artifacts bucket is versioned, and delete markers can stop
    # the CDK auto-delete handler finishing inside the CFN timeout.
    for bucket in ${SCENARIO_BUCKETS[@]+"${SCENARIO_BUCKETS[@]}"}; do
        if aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
            echo "emptying s3://$bucket"
            aws s3 rm "s3://$bucket" --recursive --only-show-errors 2>/dev/null || true
            # remove versions and delete markers if versioning is enabled
            python3 - "$bucket" <<'PY' 2>/dev/null || true
import sys
import boto3

bucket = sys.argv[1]
s3 = boto3.client("s3")
paginator = s3.get_paginator("list_object_versions")
batch = []
for page in paginator.paginate(Bucket=bucket):
    for coll in ("Versions", "DeleteMarkers"):
        for obj in page.get(coll, []):
            batch.append({"Key": obj["Key"], "VersionId": obj["VersionId"]})
            if len(batch) == 1000:
                s3.delete_objects(Bucket=bucket, Delete={"Objects": batch})
                batch = []
if batch:
    s3.delete_objects(Bucket=bucket, Delete={"Objects": batch})
print(f"purged versions in {bucket}")
PY
        fi
    done

    echo "pre-destroy sweep complete."
    exit 0
fi

echo "=== post: delete CDK custom-resource log groups ==="
for prefix in "/aws/lambda/CDK" "/aws/lambda/remediation-multiservice" "/aws/lambda/mktg-site-publisher" "/aws/lambda/pw-alpha-publisher"; do
    aws logs describe-log-groups --region "$REGION" \
        --log-group-name-prefix "$prefix" \
        --query 'logGroups[].logGroupName' --output text 2>/dev/null | \
        tr '\t' '\n' | while read -r lg; do
            [ -n "$lg" ] && aws logs delete-log-group --region "$REGION" --log-group-name "$lg" 2>/dev/null || true
        done
done

echo "=== post: sweep leftover scenario buckets ==="
for bucket in ${SCENARIO_BUCKETS[@]+"${SCENARIO_BUCKETS[@]}"}; do
    aws s3 rb "s3://$bucket" --force 2>/dev/null || true
done

echo "Cleanup complete."
exit 0
