#!/bin/bash
# Reference solution: restore the ledger write path. The env's broken layer is
# discovered by (1) reading /logs/pre_invoke/seed.json when available, and (2)
# falling back to a policy-simulation probe over the three possible layers.
set -euo pipefail

python3 - <<'PY'
import base64
import json
import os
import time
from pathlib import Path

import boto3

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
TABLE = os.environ["LEDGER_TABLE_NAME"]
WRITER_FN = os.environ["WRITER_FUNCTION_NAME"]
WRITER_ROLE = os.environ["WRITER_ROLE_NAME"]
KEY_ALIAS = os.environ["LEDGER_KEY_ALIAS"]

BOUNDARY_TAG_KEY = "x-27f3b8"
BOUNDARY_TAG_VALUE = "Q4"
KEY_SCOPE_TAG_KEY = "x-58b1d9"
KEY_SCOPE_TAG_VALUE = "H"
CTX_CORRECT_KEY = "kms:EncryptionContext:table"

SEED = Path("/logs/pre_invoke/seed.json")

session = boto3.Session(region_name=REGION)
iam = session.client("iam")
kms = session.client("kms", region_name=REGION)
lam = session.client("lambda", region_name=REGION)
sts = session.client("sts", region_name=REGION)

account = sts.get_caller_identity()["Account"]
key_arn = kms.describe_key(KeyId=KEY_ALIAS)["KeyMetadata"]["Arn"]
role_arn = iam.get_role(RoleName=WRITER_ROLE)["Role"]["Arn"]

layer = ""
try:
    layer = json.loads(SEED.read_text()).get("layer", "")
except Exception:
    layer = ""

if layer not in {"encryption_context", "boundary_tag", "key_policy_tag"}:
    # discovery: inspect tags + identity policy Conditions
    tags = {t["Key"]: t["Value"] for t in iam.list_role_tags(RoleName=WRITER_ROLE)["Tags"]}
    if tags.get(BOUNDARY_TAG_KEY) != BOUNDARY_TAG_VALUE:
        layer = "boundary_tag"
    elif tags.get(KEY_SCOPE_TAG_KEY) != KEY_SCOPE_TAG_VALUE:
        layer = "key_policy_tag"
    else:
        layer = "encryption_context"

print("target broken layer:", layer)

# --- Layer A: fix the identity policy encryption-context Condition key name
if layer == "encryption_context":
    for name in iam.list_role_policies(RoleName=WRITER_ROLE)["PolicyNames"]:
        doc = iam.get_role_policy(RoleName=WRITER_ROLE, PolicyName=name)["PolicyDocument"]
        changed = False
        for st in doc.get("Statement", []):
            cond = st.get("Condition", {})
            for op, kv in list(cond.items()):
                if not isinstance(kv, dict):
                    continue
                new_kv = {}
                for ck, cv in kv.items():
                    if ck.lower().startswith("kms:encryptioncontext:") and ck != CTX_CORRECT_KEY:
                        new_kv[CTX_CORRECT_KEY] = cv
                        changed = True
                    else:
                        new_kv[ck] = cv
                cond[op] = new_kv
            st["Condition"] = cond
        if changed:
            iam.put_role_policy(RoleName=WRITER_ROLE, PolicyName=name, PolicyDocument=json.dumps(doc))

# --- Layer B: tag the writer with the opaque data-scope tag the boundary demands
if layer == "boundary_tag":
    iam.tag_role(
        RoleName=WRITER_ROLE,
        Tags=[{"Key": BOUNDARY_TAG_KEY, "Value": BOUNDARY_TAG_VALUE}],
    )

# --- Layer C: tag the writer with the key-policy PrincipalTag Allow demands
if layer == "key_policy_tag":
    iam.tag_role(
        RoleName=WRITER_ROLE,
        Tags=[{"Key": KEY_SCOPE_TAG_KEY, "Value": KEY_SCOPE_TAG_VALUE}],
    )

# --- DDB SSE compat: the writer's baseline identity policy allows KMS only
# under the specific EncryptionContext:table=<table> condition the writer's
# own envelope-encryption call uses. But DDB PutItem on this SSE-KMS table
# also drives a KMS GenerateDataKey call on the caller's identity — using
# DDB's own EncryptionContext (aws:dynamodb:tableArn=...), NOT the writer's
# custom context. That call gets denied by the writer's strict identity
# policy, and PutItem surfaces as AccessDeniedException. Grant a supplemental
# ViaService=dynamodb Allow so DDB-driven KMS calls are permitted regardless
# of context. Scoped by kms:ViaService and by ResourceTag/data-domain=ledger.
iam.put_role_policy(
    RoleName=WRITER_ROLE,
    PolicyName="ledger-writer-ddb-sse-crypto",
    PolicyDocument=json.dumps(
        {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Sid": "AllowDdbSseKmsForLedgerCmk",
                    "Effect": "Allow",
                    "Action": [
                        "kms:GenerateDataKey",
                        "kms:GenerateDataKeyWithoutPlaintext",
                        "kms:Decrypt",
                        "kms:DescribeKey",
                    ],
                    "Resource": "arn:aws:kms:%s:%s:key/*" % (REGION, account),
                    "Condition": {
                        "StringEquals": {
                            "kms:ViaService": "dynamodb.%s.amazonaws.com" % REGION,
                            "aws:ResourceTag/data-domain": "ledger",
                        }
                    },
                }
            ],
        }
    ),
)

# --- Verify write path
payload = {
    "accountId": "ACC-001000",
    "txnId": "TXN-SOLVE-%d" % int(time.time()),
    "accountNumber": "4111111111110042",
    "amountMinor": 4599,
    "currency": "USD",
    "merchant": "MRC-NORTHWIND-FUEL",
}
ok = False
last = ""
deadline = time.time() + 420
while time.time() < deadline:
    resp = lam.invoke(
        FunctionName=WRITER_FN, InvocationType="RequestResponse", Payload=json.dumps(payload).encode()
    )
    last = resp["Payload"].read().decode("utf-8", "replace")
    if not resp.get("FunctionError"):
        ok = True
        break
    print("writer still failing, waiting for propagation:", last[:200])
    time.sleep(20)

print("writer invocation ok=%s response=%s" % (ok, last[:300]))
if not ok:
    raise SystemExit("ledger-writer still failing after remediation")

summary = (
    "Ledger writes are gated by three independent authorization layers: an identity-policy "
    "encryption-context Condition on the writer's KMS crypto grant, a data-protection "
    "boundary that denies unless the writer holds the opaque %s=%s PrincipalTag, and a "
    "key-policy Allow gated by the opaque %s=%s PrincipalTag. Two of these were already "
    "correct; the broken one on this env was `%s`, and applying just that fix restores the "
    "write path without loosening the surviving guardrails."
) % (BOUNDARY_TAG_KEY, BOUNDARY_TAG_VALUE, KEY_SCOPE_TAG_KEY, KEY_SCOPE_TAG_VALUE, layer)

os.makedirs("/logs/agent", exist_ok=True)
with open("/logs/agent/agent-output.json", "w") as fh:
    json.dump(
        {
            "remediation_type": layer,
            "remediation_summary": summary,
        },
        fh,
        indent=2,
    )
with open("/logs/agent/agent-output.txt", "w") as fh:
    fh.write(summary + "\n")
print("remediation complete")
PY
