"""Restore the ledger writer role to the state the CDK template declares.

That state is broken by design: the writer carries no data-scope tags, and its
`ledger-write-access` inline policy carries the misspelled encryption-context
key. Restoring the baseline puts the broken document back and removes both
data-scope tags. It repairs nothing.

Idempotent and best-effort: returns a list of error strings rather than raising.
"""

from __future__ import annotations

import json
import os

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
STACK_SUFFIX = "qxoqk9o4y"
STACK_NAME = "remediation-multiservice-Ledger-%s-us-east-1" % STACK_SUFFIX

WRITER_INLINE_POLICY_NAME = "ledger-write-access"
BASIC_EXEC_ARN = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"

CMK_RESOURCE_TAG_KEY = "data-domain"
CMK_RESOURCE_TAG_VALUE = "ledger"

# Layer A: the template ships this key misspelled (`tableName`, not `table`).
CTX_BROKEN_KEY = "kms:EncryptionContext:tableName"

# The tags `applyLedgerNoiseTags` puts on every ledger role. Both data-scope
# keys (`x-27f3b8`, `x-58b1d9`) are absent on purpose: the writer has neither
# at baseline, so anything outside this set is removed.
BASELINE_NOISE_TAGS = {
    "Service": "ledger-writer",
    "Owner": "payments-platform",
    "data-owner": "payments-platform",
    "region-scope": "ue1",
    "pci-band": "A",
    "audit-tier": "T2",
    "env-class": "prod",
    "iso-27001": "covered",
    "x-27f3b8-fallback": "Q3",
    "x-27f3b8-audit": "T3",
    "x-58b1d9-shadow": "X",
}


def _outputs(cfn) -> dict:
    stack = cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]
    return {o["OutputKey"]: o["OutputValue"] for o in stack.get("Outputs", [])}


def template_writer_inline(account: str, region: str, out: dict) -> dict:
    """The inline policy document `ledger-stack.ts` attaches to the writer role.

    Statement order and action order match the synthesized `ledger-write-access`
    policy, which sorts actions alphabetically.
    """
    ledger_tbl = "arn:aws:dynamodb:%s:%s:table/%s" % (
        region,
        account,
        out["LedgerTableName"],
    )
    audit_tbl = "arn:aws:dynamodb:%s:%s:table/%s" % (
        region,
        account,
        out["AuditTableName"],
    )
    queue = "arn:aws:sqs:%s:%s:%s" % (region, account, out["FailedRecordsQueueName"])
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "LedgerTableWrite",
                "Effect": "Allow",
                "Action": [
                    "dynamodb:BatchWriteItem",
                    "dynamodb:DescribeTable",
                    "dynamodb:PutItem",
                    "dynamodb:UpdateItem",
                ],
                "Resource": ledger_tbl,
            },
            {
                "Sid": "AuditTrailWrite",
                "Effect": "Allow",
                "Action": "dynamodb:PutItem",
                "Resource": audit_tbl,
            },
            {
                "Sid": "FailedRecordPublish",
                "Effect": "Allow",
                "Action": [
                    "sqs:GetQueueAttributes",
                    "sqs:GetQueueUrl",
                    "sqs:SendMessage",
                ],
                "Resource": queue,
            },
            {
                "Sid": "LedgerFieldEnvelopeEncrypt",
                "Effect": "Allow",
                "Action": [
                    "kms:Decrypt",
                    "kms:DescribeKey",
                    "kms:GenerateDataKey",
                    "kms:GenerateDataKeyWithoutPlaintext",
                ],
                "Resource": "arn:aws:kms:%s:%s:key/*" % (region, account),
                "Condition": {
                    "StringEquals": {
                        "aws:ResourceTag/%s"
                        % CMK_RESOURCE_TAG_KEY: CMK_RESOURCE_TAG_VALUE,
                        CTX_BROKEN_KEY: out["LedgerTableName"],
                    }
                },
            },
        ],
    }


def restore(session: boto3.Session | None = None, region: str = REGION) -> list[str]:
    """Put the writer role back to template state. Returns error strings."""
    errors: list[str] = []
    session = session or boto3.Session(region_name=region)
    iam = session.client("iam")
    cfn = session.client("cloudformation", region_name=region)
    kms = session.client("kms", region_name=region)

    try:
        out = _outputs(cfn)
        account = session.client("sts", region_name=region).get_caller_identity()[
            "Account"
        ]
    except ClientError as exc:
        return ["could not read Ledger stack outputs: %s" % exc]

    writer_role = out["WriterRoleName"]
    boundary_arn = "arn:aws:iam::%s:policy/%s" % (account, out["BoundaryPolicyName"])
    region_boundary_arn = "arn:aws:iam::%s:policy/%s" % (
        account,
        out["RegionBoundaryPolicyName"],
    )

    # Inline policies: only ledger-write-access exists in the template, carrying
    # the layer-A document.
    try:
        for name in iam.list_role_policies(RoleName=writer_role)["PolicyNames"]:
            if name != WRITER_INLINE_POLICY_NAME:
                iam.delete_role_policy(RoleName=writer_role, PolicyName=name)
        iam.put_role_policy(
            RoleName=writer_role,
            PolicyName=WRITER_INLINE_POLICY_NAME,
            PolicyDocument=json.dumps(template_writer_inline(account, region, out)),
        )
    except ClientError as exc:
        errors.append("writer inline policies: %s" % exc)

    # Attached policies: the template attaches exactly these three.
    allowed = {boundary_arn, region_boundary_arn, BASIC_EXEC_ARN}
    try:
        for pol in iam.list_attached_role_policies(RoleName=writer_role)[
            "AttachedPolicies"
        ]:
            if pol["PolicyArn"] not in allowed:
                iam.detach_role_policy(RoleName=writer_role, PolicyArn=pol["PolicyArn"])
        for arn in allowed:
            try:
                iam.attach_role_policy(RoleName=writer_role, PolicyArn=arn)
            except ClientError:
                pass
    except ClientError as exc:
        errors.append("writer attached policies: %s" % exc)

    # Tags: noise tags only. Both data-scope tags are absent in the template, so
    # anything else is removed.
    try:
        current = {
            t["Key"]: t["Value"]
            for t in iam.list_role_tags(RoleName=writer_role)["Tags"]
        }
        stale = [k for k in current if k not in BASELINE_NOISE_TAGS]
        if stale:
            iam.untag_role(RoleName=writer_role, TagKeys=stale)
        iam.tag_role(
            RoleName=writer_role,
            Tags=[{"Key": k, "Value": v} for k, v in BASELINE_NOISE_TAGS.items()],
        )
    except ClientError as exc:
        errors.append("writer role tags: %s" % exc)

    # KMS grants: the template creates none for the writer, so any grant naming it
    # was installed during a trial. The stack exports the alias, not the key ARN.
    try:
        key_id = kms.describe_key(KeyId=out["LedgerKeyAliasName"])["KeyMetadata"]["Arn"]
        marker = "role/%s" % writer_role
        for page in kms.get_paginator("list_grants").paginate(KeyId=key_id):
            for grant in page.get("Grants", []):
                if marker in str(grant.get("GranteePrincipal", "")):
                    kms.revoke_grant(KeyId=key_id, GrantId=grant["GrantId"])
    except (ClientError, KeyError) as exc:
        errors.append("writer KMS grants: %s" % exc)

    return errors


if __name__ == "__main__":
    for err in restore():
        print("reset: %s" % err)
