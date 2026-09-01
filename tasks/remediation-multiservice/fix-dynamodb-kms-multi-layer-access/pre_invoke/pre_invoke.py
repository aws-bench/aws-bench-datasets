"""Trial-fresh state for the ledger AccessDenied scenario.

The multi-layer authorization design consists of three independent gates:
  A) an encryption-context condition on the writer's identity policy,
  B) a data-protection boundary Deny keyed on an opaque PrincipalTag, and
  C) an opaque PrincipalTag Allow on the ledger CMK key policy.

pre_invoke picks ONE of those three deterministically per environment (sha256
of account id + stack suffix, mod 3) and leaves it broken. The other two are
reset to a fully-correct state, so there is exactly one blocker per trial.

pre_invoke also regenerates real symptoms (failing writer, backlog, alarm
ALARM) and records the chosen layer to /logs/pre_invoke/seed.json.
"""

import hashlib
import json
import os
import sys
import time
from typing import Optional

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
STACK_SUFFIX = "qxoqk9o4y"
STACK_NAME = "remediation-multiservice-Ledger-%s-us-east-1" % STACK_SUFFIX

WRITER_INLINE_POLICY_NAME = "ledger-write-access"
BASIC_EXEC_ARN = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"

# Opaque data-scope tags (kept in sync with the CDK stack).
BOUNDARY_TAG_KEY = "x-27f3b8"
BOUNDARY_TAG_VALUE = "Q4"
KEY_SCOPE_TAG_KEY = "x-58b1d9"
KEY_SCOPE_TAG_VALUE = "H"
CMK_RESOURCE_TAG_KEY = "data-domain"
CMK_RESOURCE_TAG_VALUE = "ledger"

# The writer's real EncryptionContext key is "table". Layer A's broken variant
# substitutes a plausible camelCase typo so the identity policy Condition
# silently misses on every call.
CTX_CORRECT_KEY = "kms:EncryptionContext:table"
CTX_BROKEN_KEY = "kms:EncryptionContext:tableName"

LAYERS = ("encryption_context", "boundary_tag", "key_policy_tag")

# Noise tags applied to the writer role at every reset. The single meaningful
# differences live inside the two data-scope keys below.
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
PLACEHOLDER_PATH = "/logs/pre_invoke/placeholder.json"
SEED_PATH = "/logs/pre_invoke/seed.json"


# --------------------------------------------------------------------------- util
def _outputs(cfn) -> dict:
    resp = cfn.describe_stacks(StackName=STACK_NAME)
    return {
        o["OutputKey"]: o["OutputValue"] for o in resp["Stacks"][0].get("Outputs", [])
    }


def _norm(doc: dict):
    """Order-insensitive normalisation of a policy document for comparison."""
    out = []
    for st in doc.get("Statement", []):
        actions = st.get("Action", [])
        actions = [actions] if isinstance(actions, str) else list(actions)
        res = st.get("Resource", [])
        res = [res] if isinstance(res, str) else list(res)
        out.append(
            (
                st.get("Sid", ""),
                st.get("Effect", ""),
                tuple(sorted(actions)),
                tuple(sorted(res)),
                json.dumps(st.get("Condition", {}), sort_keys=True),
                json.dumps(st.get("Principal", {}), sort_keys=True),
            )
        )
    return sorted(out)


def _key_arn(kms, alias: str) -> str:
    return kms.describe_key(KeyId=alias)["KeyMetadata"]["Arn"]


def _pick_layer(account: str) -> str:
    digest = hashlib.sha256(("%s|%s" % (account, STACK_SUFFIX)).encode()).digest()
    return LAYERS[digest[0] % len(LAYERS)]


# ----------------------------------------------------------------- baseline docs
def baseline_writer_inline(account, region, out, layer: str) -> dict:
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
    ctx_key = CTX_BROKEN_KEY if layer == "encryption_context" else CTX_CORRECT_KEY
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "LedgerTableWrite",
                "Effect": "Allow",
                "Action": [
                    "dynamodb:PutItem",
                    "dynamodb:UpdateItem",
                    "dynamodb:BatchWriteItem",
                    "dynamodb:DescribeTable",
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
                    "sqs:SendMessage",
                    "sqs:GetQueueUrl",
                    "sqs:GetQueueAttributes",
                ],
                "Resource": queue,
            },
            {
                "Sid": "LedgerFieldEnvelopeEncrypt",
                "Effect": "Allow",
                "Action": [
                    "kms:GenerateDataKey",
                    "kms:GenerateDataKeyWithoutPlaintext",
                    "kms:Decrypt",
                    "kms:DescribeKey",
                ],
                "Resource": "arn:aws:kms:%s:%s:key/*" % (region, account),
                "Condition": {
                    "StringEquals": {
                        "aws:ResourceTag/%s"
                        % CMK_RESOURCE_TAG_KEY: CMK_RESOURCE_TAG_VALUE,
                        ctx_key: out["LedgerTableName"],
                    }
                },
            },
        ],
    }


def baseline_key_policy(account, region, out) -> dict:
    root = "arn:aws:iam::%s:root" % account
    backfill_arn = "arn:aws:iam::%s:role/%s" % (account, out["BackfillRoleName"])
    reader_arn = "arn:aws:iam::%s:role/%s" % (account, out["ReaderRoleName"])
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "AllowKeyAdministration",
                "Effect": "Allow",
                "Principal": {"AWS": root},
                "Action": [
                    "kms:CancelKeyDeletion",
                    "kms:CreateAlias",
                    "kms:CreateGrant",
                    "kms:DeleteAlias",
                    "kms:Describe*",
                    "kms:Disable*",
                    "kms:Enable*",
                    "kms:Get*",
                    "kms:List*",
                    "kms:Put*",
                    "kms:Retire*",
                    "kms:Revoke*",
                    "kms:ScheduleKeyDeletion",
                    "kms:TagResource",
                    "kms:UntagResource",
                    "kms:Update*",
                ],
                "Resource": "*",
            },
            {
                "Sid": "AllowDynamoDbServiceIntegration",
                "Effect": "Allow",
                "Principal": {"AWS": root},
                "Action": [
                    "kms:CreateGrant",
                    "kms:Decrypt",
                    "kms:DescribeKey",
                    "kms:Encrypt",
                    "kms:GenerateDataKey*",
                    "kms:ReEncrypt*",
                ],
                "Resource": "*",
                "Condition": {
                    "StringEquals": {
                        "kms:ViaService": "dynamodb.%s.amazonaws.com" % region,
                        "kms:CallerAccount": account,
                    }
                },
            },
            {
                "Sid": "AllowLedgerCryptoByPrincipalTag",
                "Effect": "Allow",
                "Principal": {"AWS": root},
                "Action": [
                    "kms:Decrypt",
                    "kms:DescribeKey",
                    "kms:Encrypt",
                    "kms:GenerateDataKey*",
                ],
                "Resource": "*",
                "Condition": {
                    "StringEquals": {
                        "aws:PrincipalTag/%s" % KEY_SCOPE_TAG_KEY: KEY_SCOPE_TAG_VALUE,
                    }
                },
            },
            # Sibling permanent Allow: backfill+reader keep crypto access even
            # without their data-scope tags. Writer is intentionally NOT listed
            # so Layer C still blocks it via the PrincipalTag Allow.
            {
                "Sid": "AllowLedgerCryptoForSiblingRoles",
                "Effect": "Allow",
                "Principal": {"AWS": [backfill_arn, reader_arn]},
                "Action": [
                    "kms:Decrypt",
                    "kms:DescribeKey",
                    "kms:Encrypt",
                    "kms:GenerateDataKey*",
                ],
                "Resource": "*",
            },
        ],
    }


def baseline_boundary(out) -> dict:
    key_arn = out["_ledgerKeyArn"]
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "DenyLedgerKeyUseByUntaggedPrincipals",
                "Effect": "Deny",
                "Action": [
                    "kms:GenerateDataKey*",
                    "kms:Encrypt",
                    "kms:Decrypt",
                    "kms:ReEncrypt*",
                ],
                "Resource": key_arn,
                "Condition": {
                    "StringNotEquals": {
                        "aws:PrincipalTag/%s" % BOUNDARY_TAG_KEY: BOUNDARY_TAG_VALUE
                    }
                },
            },
            {
                "Sid": "DenyLedgerKeyDestruction",
                "Effect": "Deny",
                "Action": [
                    "kms:ScheduleKeyDeletion",
                    "kms:DisableKey",
                    "kms:DisableKeyRotation",
                ],
                "Resource": key_arn,
            },
            {
                "Sid": "AllowLedgerKeyMetadata",
                "Effect": "Allow",
                "Action": "kms:DescribeKey",
                "Resource": key_arn,
            },
        ],
    }


def baseline_region_boundary(out) -> dict:
    key_arn = out["_ledgerKeyArn"]
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "DenyLedgerKeyUseInSecondaryRegion",
                "Effect": "Deny",
                "Action": [
                    "kms:GenerateDataKey*",
                    "kms:Encrypt",
                    "kms:Decrypt",
                    "kms:ReEncrypt*",
                ],
                "Resource": key_arn,
                "Condition": {"StringEquals": {"aws:RequestedRegion": "us-east-2"}},
            },
        ],
    }


def writer_baseline_tags(layer: str) -> dict:
    """Return the full role-tag set for the writer given the picked broken layer.

    * layer == encryption_context: writer has BOTH data-scope tags (boundary + key
      policy). Only the identity-policy typo blocks.
    * layer == boundary_tag: writer holds only the key-policy tag; the boundary
      DENY blocks.
    * layer == key_policy_tag: writer holds only the boundary tag; the key policy
      Allow condition is unsatisfied.
    """
    tags = dict(BASELINE_NOISE_TAGS)
    if layer != "boundary_tag":
        tags[BOUNDARY_TAG_KEY] = BOUNDARY_TAG_VALUE
    if layer != "key_policy_tag":
        tags[KEY_SCOPE_TAG_KEY] = KEY_SCOPE_TAG_VALUE
    return tags


# --------------------------------------------------------------------- the reset
def reset_baseline(session, region: str, out: dict, layer: str) -> None:
    account = session.client("sts", region_name=region).get_caller_identity()["Account"]
    iam = session.client("iam")
    kms = session.client("kms", region_name=region)
    lam = session.client("lambda", region_name=region)
    ddb = session.client("dynamodb", region_name=region)
    sqs = session.client("sqs", region_name=region)

    writer_role = out["WriterRoleName"]
    boundary_arn = "arn:aws:iam::%s:policy/%s" % (account, out["BoundaryPolicyName"])
    region_boundary_arn = "arn:aws:iam::%s:policy/%s" % (
        account,
        out["RegionBoundaryPolicyName"],
    )

    # 1. writer identity policies -> baseline (layer-dependent Condition body)
    for name in iam.list_role_policies(RoleName=writer_role)["PolicyNames"]:
        if name != WRITER_INLINE_POLICY_NAME:
            iam.delete_role_policy(RoleName=writer_role, PolicyName=name)
    iam.put_role_policy(
        RoleName=writer_role,
        PolicyName=WRITER_INLINE_POLICY_NAME,
        PolicyDocument=json.dumps(baseline_writer_inline(account, region, out, layer)),
    )
    allowed_attached = {boundary_arn, region_boundary_arn, BASIC_EXEC_ARN}
    for pol in iam.list_attached_role_policies(RoleName=writer_role)[
        "AttachedPolicies"
    ]:
        if pol["PolicyArn"] not in allowed_attached:
            iam.detach_role_policy(RoleName=writer_role, PolicyArn=pol["PolicyArn"])
    for arn in allowed_attached:
        try:
            iam.attach_role_policy(RoleName=writer_role, PolicyArn=arn)
        except ClientError:
            pass

    # 2. writer role tags -> baseline (layer-dependent data-scope tag presence)
    want_tags = writer_baseline_tags(layer)
    current = {
        t["Key"]: t["Value"] for t in iam.list_role_tags(RoleName=writer_role)["Tags"]
    }
    stale = [k for k in current if k not in want_tags]
    if stale:
        iam.untag_role(RoleName=writer_role, TagKeys=stale)
    iam.tag_role(
        RoleName=writer_role,
        Tags=[{"Key": k, "Value": v} for k, v in want_tags.items()],
    )

    # 3. data protection boundary policy -> baseline document
    want = baseline_boundary(out)
    versions = iam.list_policy_versions(PolicyArn=boundary_arn)["Versions"]
    default = next(v for v in versions if v["IsDefaultVersion"])
    have = iam.get_policy_version(
        PolicyArn=boundary_arn, VersionId=default["VersionId"]
    )["PolicyVersion"]["Document"]
    if isinstance(have, str):
        have = json.loads(have)
    if _norm(have) != _norm(want):
        for v in versions:
            if not v["IsDefaultVersion"]:
                iam.delete_policy_version(
                    PolicyArn=boundary_arn, VersionId=v["VersionId"]
                )
        iam.create_policy_version(
            PolicyArn=boundary_arn, PolicyDocument=json.dumps(want), SetAsDefault=True
        )

    # 3b. regional data protection boundary policy -> baseline document
    want_rb = baseline_region_boundary(out)
    rb_versions = iam.list_policy_versions(PolicyArn=region_boundary_arn)["Versions"]
    rb_default = next(v for v in rb_versions if v["IsDefaultVersion"])
    have_rb = iam.get_policy_version(
        PolicyArn=region_boundary_arn, VersionId=rb_default["VersionId"]
    )["PolicyVersion"]["Document"]
    if isinstance(have_rb, str):
        have_rb = json.loads(have_rb)
    if _norm(have_rb) != _norm(want_rb):
        for v in rb_versions:
            if not v["IsDefaultVersion"]:
                iam.delete_policy_version(
                    PolicyArn=region_boundary_arn, VersionId=v["VersionId"]
                )
        iam.create_policy_version(
            PolicyArn=region_boundary_arn,
            PolicyDocument=json.dumps(want_rb),
            SetAsDefault=True,
        )

    # 4. ledger CMK key policy -> PrincipalTag baseline, and drop any grant for
    #    the writer role that a previous trial may have installed.
    key_id = out["_ledgerKeyArn"]
    want_kp = baseline_key_policy(account, region, out)
    have_kp = json.loads(
        kms.get_key_policy(KeyId=key_id, PolicyName="default")["Policy"]
    )
    if _norm(have_kp) != _norm(want_kp):
        kms.put_key_policy(
            KeyId=key_id, PolicyName="default", Policy=json.dumps(want_kp)
        )
    marker = "role/%s" % writer_role
    paginator = kms.get_paginator("list_grants")
    for page in paginator.paginate(KeyId=key_id):
        for grant in page.get("Grants", []):
            if marker in str(grant.get("GranteePrincipal", "")):
                try:
                    kms.revoke_grant(KeyId=key_id, GrantId=grant["GrantId"])
                except ClientError:
                    pass

    # 5. writer Lambda configuration -> baseline
    cfg = lam.get_function_configuration(FunctionName=out["WriterFunctionName"])
    env = dict(cfg.get("Environment", {}).get("Variables", {}))
    want_env = {
        "LEDGER_TABLE_NAME": out["LedgerTableName"],
        "LEDGER_KMS_KEY_ARN": out["_ledgerKeyArn"],
        "FAILED_RECORDS_QUEUE_URL": out["_queueUrl"],
        "WRITER_VERSION": "2.4.1",
    }
    if env != want_env:
        lam.update_function_configuration(
            FunctionName=out["WriterFunctionName"], Environment={"Variables": want_env}
        )
        waiter = lam.get_waiter("function_updated_v2")
        waiter.wait(FunctionName=out["WriterFunctionName"])

    # 6. remove verification rows written by a previous trial
    scan = ddb.scan(
        TableName=out["LedgerTableName"],
        ProjectionExpression="accountId,txnId",
        FilterExpression="begins_with(accountId, :p)",
        ExpressionAttributeValues={":p": {"S": "ACC-VERIFY"}},
    )
    for item in scan.get("Items", []):
        ddb.delete_item(
            TableName=out["LedgerTableName"],
            Key={"accountId": item["accountId"], "txnId": item["txnId"]},
        )

    # 7. drain the failed-records queue
    for _ in range(25):
        msgs = sqs.receive_message(
            QueueUrl=out["_queueUrl"], MaxNumberOfMessages=10, WaitTimeSeconds=1
        ).get("Messages", [])
        if not msgs:
            break
        sqs.delete_message_batch(
            QueueUrl=out["_queueUrl"],
            Entries=[
                {"Id": str(i), "ReceiptHandle": m["ReceiptHandle"]}
                for i, m in enumerate(msgs)
            ],
        )


# ---------------------------------------------------------------------- symptoms
def _invoke_writer(lam, fn_name: str, idx: int):
    payload = {
        "accountId": "ACC-%06d" % (1000 + (idx % 12)),
        "txnId": "TXN-LIVE-%d-%03d" % (int(time.time()) // 3600, idx),
        "accountNumber": "4111111111%06d" % (100000 + idx),
        "amountMinor": 1299 + idx * 37,
        "currency": "USD",
        "merchant": "MRC-ATLAS-AIRLINES",
    }
    resp = lam.invoke(
        FunctionName=fn_name,
        InvocationType="RequestResponse",
        Payload=json.dumps(payload).encode(),
    )
    body = resp["Payload"].read().decode("utf-8", "replace")
    return resp.get("FunctionError"), body


def generate_symptoms(session, region: str, out: dict) -> None:
    lam = session.client("lambda", region_name=region)
    cw = session.client("cloudwatch", region_name=region)
    sqs = session.client("sqs", region_name=region)
    logsc = session.client("logs", region_name=region)

    writer_fn = out["WriterFunctionName"]

    # the writer must be failing before we count on any of the downstream symptoms
    deadline = time.time() + 240
    idx = 0
    while time.time() < deadline:
        err, body = _invoke_writer(lam, writer_fn, idx)
        idx += 1
        if err:
            break
        time.sleep(15)
    else:
        raise RuntimeError(
            "ledger-writer unexpectedly succeeded; baseline reset failed"
        )

    # a few more failures so CloudWatch has several datapoints
    for _ in range(5):
        _invoke_writer(lam, writer_fn, idx)
        idx += 1
        time.sleep(2)

    # contrast: the read path works
    reader_ok = False
    for txn in ("TXN-HIST-00000", "TXN-HIST-00001"):
        resp = lam.invoke(
            FunctionName=out["ReaderFunctionName"],
            InvocationType="RequestResponse",
            Payload=json.dumps({"accountId": "ACC-001000", "txnId": txn}).encode(),
        )
        body = json.loads(resp["Payload"].read() or b"{}")
        if not resp.get("FunctionError") and body.get("decrypted"):
            reader_ok = True
    if not reader_ok:
        raise RuntimeError("ledger-reader baseline path is broken")

    # failed-record backlog
    deadline = time.time() + 120
    while time.time() < deadline:
        attrs = sqs.get_queue_attributes(
            QueueUrl=out["_queueUrl"], AttributeNames=["ApproximateNumberOfMessages"]
        )["Attributes"]
        if int(attrs.get("ApproximateNumberOfMessages", "0")) >= 1:
            break
        time.sleep(10)
    else:
        raise RuntimeError("failed-records queue never accumulated messages")

    # log evidence
    log_group = "/aws/lambda/%s" % writer_fn
    deadline = time.time() + 180
    while time.time() < deadline:
        try:
            events = logsc.filter_log_events(
                logGroupName=log_group,
                startTime=int((time.time() - 1800) * 1000),
                filterPattern="ledger.persist_failed",
                limit=5,
            ).get("events", [])
        except ClientError:
            events = []
        if events:
            break
        time.sleep(10)
    else:
        raise RuntimeError("writer failure log events never became queryable")

    # alarm must be settled in ALARM
    alarm_name = out["WriterAlarmName"]
    deadline = time.time() + 420
    last_kick = time.time()
    while time.time() < deadline:
        state = cw.describe_alarms(AlarmNames=[alarm_name])["MetricAlarms"][0][
            "StateValue"
        ]
        if state == "ALARM":
            return
        if time.time() - last_kick > 90:
            _invoke_writer(lam, writer_fn, idx)
            idx += 1
            last_kick = time.time()
        time.sleep(15)
    raise RuntimeError("alarm %s did not reach ALARM" % alarm_name)


def run(session: Optional[boto3.Session] = None, region: str = REGION, **kwargs):
    if session is None:
        session = boto3.Session()

    cfn = session.client("cloudformation", region_name=region)
    kms = session.client("kms", region_name=region)
    sqs = session.client("sqs", region_name=region)
    sts = session.client("sts", region_name=region)

    out = _outputs(cfn)
    out["_ledgerKeyArn"] = _key_arn(kms, out["LedgerKeyAliasName"])
    out["_analyticsKeyArn"] = _key_arn(kms, out["AnalyticsKeyAliasName"])
    out["_queueUrl"] = sqs.get_queue_url(QueueName=out["FailedRecordsQueueName"])[
        "QueueUrl"
    ]

    account = sts.get_caller_identity()["Account"]
    layer = _pick_layer(account)

    reset_baseline(session, region, out, layer)
    generate_symptoms(session, region, out)

    os.makedirs(os.path.dirname(PLACEHOLDER_PATH), exist_ok=True)
    with open(PLACEHOLDER_PATH, "w") as fh:
        json.dump({}, fh)
    with open(SEED_PATH, "w") as fh:
        json.dump({"layer": layer, "account": account, "suffix": STACK_SUFFIX}, fh)
    print(
        "pre_invoke complete: writer failing on layer=%s, backlog present, alarm in ALARM"
        % layer
    )


if __name__ == "__main__":
    try:
        run()
    except Exception as exc:  # noqa: BLE001
        print("pre_invoke failed: %s" % exc, file=sys.stderr)
        raise
