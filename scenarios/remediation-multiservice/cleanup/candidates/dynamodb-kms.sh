#!/bin/bash
# KMS-encrypted DynamoDB ledger cleanup. `pre` runs before the shared `cdk destroy --all`, `post` after.
set -uo pipefail

PHASE="${1:?usage: $0 pre|post}"

export AWS_PROFILE=PRIMARY
REGION="us-east-1"
SUFFIX="qxoqk9o4y"

if [ "$PHASE" = "pre" ]; then
    echo "=== pre: clear resources that block stack deletion ==="
    # DeleteRole fails while a role carries policies CloudFormation does not own.
    # ScheduleKeyDeletion requires the key policy to still delegate administration
    # to the account root.
    python3 - "$REGION" "$SUFFIX" <<'PY' || true
import json
import sys

import boto3
from botocore.exceptions import ClientError

region, suffix = sys.argv[1], sys.argv[2]
session = boto3.Session(profile_name="PRIMARY")
iam = session.client("iam")
kms = session.client("kms", region_name=region)
account = session.client("sts", region_name=region).get_caller_identity()["Account"]

roles = [
    "ledger-writer-role-%s" % suffix,
    "ledger-reader-role-%s" % suffix,
    "ledger-backfill-role-%s" % suffix,
    "ledger-reconciler-role-%s" % suffix,
]
for role in roles:
    try:
        for name in iam.list_role_policies(RoleName=role)["PolicyNames"]:
            try:
                iam.delete_role_policy(RoleName=role, PolicyName=name)
                print("deleted inline policy %s/%s" % (role, name))
            except ClientError:
                pass
        for pol in iam.list_attached_role_policies(RoleName=role)["AttachedPolicies"]:
            try:
                iam.detach_role_policy(RoleName=role, PolicyArn=pol["PolicyArn"])
                print("detached %s from %s" % (pol["PolicyArn"], role))
            except ClientError:
                pass
    except ClientError:
        continue

root = "arn:aws:iam::%s:root" % account
admin_policy = {
    "Version": "2012-10-17",
    "Statement": [{"Effect": "Allow", "Principal": {"AWS": root}, "Action": "kms:*", "Resource": "*"}],
}
for alias in ("alias/ledger-pci-%s" % suffix, "alias/ledger-analytics-%s" % suffix):
    try:
        key_arn = kms.describe_key(KeyId=alias)["KeyMetadata"]["Arn"]
        kms.put_key_policy(KeyId=key_arn, PolicyName="default", Policy=json.dumps(admin_policy))
        print("restored root administration on %s" % alias)
    except ClientError as exc:
        print("skip %s: %s" % (alias, exc))
PY

    # Empty the analytics report bucket (belt and braces; autoDeleteObjects also covers it)
    for bucket in $(aws s3api list-buckets --query "Buckets[?starts_with(Name, 'ledger-reports-')].Name" --output text 2>/dev/null); do
        aws s3 rm "s3://${bucket}" --recursive 2>/dev/null || true
    done

    echo "pre-destroy sweep complete."
    exit 0
fi

echo "=== post: delete leftover log groups ==="
for prefix in "/aws/lambda/CDK" "/aws/lambda/ledger-" "/aws/lambda/remediation-multiservice"; do
    aws logs describe-log-groups --region "$REGION" \
        --log-group-name-prefix "$prefix" \
        --query 'logGroups[].logGroupName' --output text 2>/dev/null | \
        tr '\t' '\n' | while read -r lg; do
            [ -n "$lg" ] && aws logs delete-log-group --region "$REGION" --log-group-name "$lg" 2>/dev/null || true
        done
done

echo "=== post: sweep orphaned ledger IAM policies and roles ==="
for pol in $(aws iam list-policies --scope Local --query "Policies[?contains(PolicyName, '${SUFFIX}')].Arn" --output text 2>/dev/null); do
    for v in $(aws iam list-policy-versions --policy-arn "$pol" --query 'Versions[?!IsDefaultVersion].VersionId' --output text 2>/dev/null); do
        aws iam delete-policy-version --policy-arn "$pol" --version-id "$v" 2>/dev/null || true
    done
    aws iam delete-policy --policy-arn "$pol" 2>/dev/null || true
done
for role in $(aws iam list-roles --query "Roles[?contains(RoleName, 'ledger-') && contains(RoleName, '${SUFFIX}')].RoleName" --output text 2>/dev/null); do
    for name in $(aws iam list-role-policies --role-name "$role" --query 'PolicyNames[]' --output text 2>/dev/null); do
        aws iam delete-role-policy --role-name "$role" --policy-name "$name" 2>/dev/null || true
    done
    for arn in $(aws iam list-attached-role-policies --role-name "$role" --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
        aws iam detach-role-policy --role-name "$role" --policy-arn "$arn" 2>/dev/null || true
    done
    aws iam delete-role --role-name "$role" 2>/dev/null || true
done

echo "=== post: delete setup-written SSM parameters ==="
# Written outside CDK, so it survives redeploys without this delete.
aws ssm delete-parameter --name "/platform/ledger/${SUFFIX}/tag-schema" --region "$REGION" 2>/dev/null || true

echo "Cleanup complete."
exit 0
