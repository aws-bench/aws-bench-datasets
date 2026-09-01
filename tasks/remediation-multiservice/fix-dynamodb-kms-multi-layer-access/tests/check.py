"""Verification for the ledger AccessDenied remediation task.

pre_invoke leaves one of three authorization layers broken and records the
choice in /logs/pre_invoke/seed.json. This file cannot read that path: only
``tests/`` is bind-mounted into the verifier container. The criteria assert
live state instead — the writer end-state (an envelope-encrypted PAN persisted
and readable), and that the guardrail semantics of the un-broken layers held.
"""

import base64
import json
import os
import random
import time
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")

LEDGER_TABLE = os.environ.get("LEDGER_TABLE_NAME", "")
WRITER_FN = os.environ.get("WRITER_FUNCTION_NAME", "")
READER_FN = os.environ.get("READER_FUNCTION_NAME", "")
WRITER_ROLE = os.environ.get("WRITER_ROLE_NAME", "")
BOUNDARY_POLICY = os.environ.get("BOUNDARY_POLICY_NAME", "")
REGION_BOUNDARY_POLICY = os.environ.get("REGION_BOUNDARY_POLICY_NAME", "")
LEDGER_KEY_ALIAS = os.environ.get("LEDGER_KEY_ALIAS", "")

BOUNDARY_TAG_KEY = "x-27f3b8"
BOUNDARY_TAG_VALUE = "Q4"

session = boto3.Session(region_name=REGION)

CRYPTO_ACTIONS = {
    "kms:*",
    "*",
    "kms:generatedatakey",
    "kms:generatedatakey*",
    "kms:generatedatakeywithoutplaintext",
    "kms:decrypt",
    "kms:encrypt",
    "kms:reencrypt*",
    "kms:reencryptfrom",
    "kms:reencryptto",
}

_WRITE_RESULT = None
_WRITE_CACHE = Path("/tmp/ledger-write-result.json")


def _ledger_key_arn() -> str:
    kms = session.client("kms")
    return kms.describe_key(KeyId=LEDGER_KEY_ALIAS)["KeyMetadata"]["Arn"]


def _as_list(value):
    if value is None:
        return []
    return [value] if isinstance(value, str) else list(value)


def _attempt_write() -> dict:
    """Invoke the online writer until it persists a fresh transaction (or give up)."""
    global _WRITE_RESULT
    if _WRITE_RESULT is not None:
        return _WRITE_RESULT
    if _WRITE_CACHE.exists():
        try:
            cached = json.loads(_WRITE_CACHE.read_text())
            if cached.get("ok"):
                _WRITE_RESULT = cached
                return _WRITE_RESULT
        except Exception:  # noqa: BLE001
            pass

    result = {"ok": False, "item": None, "last4": "", "accountId": "", "txnId": ""}
    try:
        lam = session.client("lambda")
        ddb = session.client("dynamodb")
        last4 = "%04d" % random.Random(int(time.time())).randint(1000, 9999)
        account_id = "ACC-VERIFY-01"
        txn_id = "VERIFY-%d" % int(time.time())
        payload = {
            "accountId": account_id,
            "txnId": txn_id,
            "accountNumber": "411111111111" + last4,
            "amountMinor": 24999,
            "currency": "USD",
            "merchant": "MRC-ATLAS-AIRLINES",
        }
        result.update({"last4": last4, "accountId": account_id, "txnId": txn_id})

        for attempt in range(6):
            resp = lam.invoke(
                FunctionName=WRITER_FN,
                InvocationType="RequestResponse",
                Payload=json.dumps(payload).encode("utf-8"),
            )
            body = resp["Payload"].read().decode("utf-8", "replace")
            if not resp.get("FunctionError"):
                try:
                    parsed = json.loads(body or "{}")
                except ValueError:
                    parsed = {}
                if parsed.get("statusCode") == 200 and txn_id in (
                    parsed.get("written") or []
                ):
                    result["ok"] = True
                    break
            if attempt < 5:
                time.sleep(20)

        if result["ok"]:
            item = ddb.get_item(
                TableName=LEDGER_TABLE,
                Key={"accountId": {"S": account_id}, "txnId": {"S": txn_id}},
                ConsistentRead=True,
            ).get("Item")
            result["item"] = item
    except ClientError:
        pass
    except Exception:  # noqa: BLE001
        pass

    _WRITE_RESULT = result
    try:
        _WRITE_CACHE.write_text(json.dumps(result))
    except Exception:  # noqa: BLE001
        pass
    return result


def _writer_identity_docs() -> list:
    iam = session.client("iam")
    docs = []
    for name in iam.list_role_policies(RoleName=WRITER_ROLE)["PolicyNames"]:
        docs.append(
            iam.get_role_policy(RoleName=WRITER_ROLE, PolicyName=name)["PolicyDocument"]
        )
    for pol in iam.list_attached_role_policies(RoleName=WRITER_ROLE)[
        "AttachedPolicies"
    ]:
        meta = iam.get_policy(PolicyArn=pol["PolicyArn"])["Policy"]
        pv = iam.get_policy_version(
            PolicyArn=pol["PolicyArn"], VersionId=meta["DefaultVersionId"]
        )["PolicyVersion"]["Document"]
        if isinstance(pv, str):
            pv = json.loads(pv)
        docs.append(pv)
    return docs


@criterion(
    description="ledger-writer now persists a transaction with an envelope-encrypted PAN"
)
def writer_persists_encrypted_transaction(workspace: Path) -> bool:
    try:
        res = _attempt_write()
        item = res.get("item")
        if not res["ok"] or not item:
            return False
        wrapped = base64.b64decode(item["dataKeyCiphertext"]["S"])
        return all(
            [
                "accountNumberEnc" in item,
                "accountNumber" not in item,
                len(wrapped) >= 100,
                item["status"]["S"] == "POSTED",
            ]
        )
    except Exception:  # noqa: BLE001
        return False


@criterion(
    description="ledger-reader can decrypt the newly written record back to the original PAN"
)
def reader_decrypts_new_record(workspace: Path) -> bool:
    try:
        res = _attempt_write()
        if not res["ok"]:
            return False
        lam = session.client("lambda")
        resp = lam.invoke(
            FunctionName=READER_FN,
            InvocationType="RequestResponse",
            Payload=json.dumps(
                {"accountId": res["accountId"], "txnId": res["txnId"]}
            ).encode(),
        )
        if resp.get("FunctionError"):
            return False
        body = json.loads(resp["Payload"].read() or b"{}")
        return (
            bool(body.get("decrypted"))
            and body.get("accountNumberLast4") == res["last4"]
        )
    except Exception:  # noqa: BLE001
        return False


@criterion(
    description="Data protection boundary Deny is still enforced on the writer role"
)
def guardrail_deny_preserved(workspace: Path) -> bool:
    try:
        iam = session.client("iam")
        account = session.client("sts").get_caller_identity()["Account"]
        policy_arn = "arn:aws:iam::%s:policy/%s" % (account, BOUNDARY_POLICY)
        attached = [
            p["PolicyArn"]
            for p in iam.list_attached_role_policies(RoleName=WRITER_ROLE)[
                "AttachedPolicies"
            ]
        ]
        if policy_arn not in attached:
            return False
        pol = iam.get_policy(PolicyArn=policy_arn)["Policy"]
        doc = iam.get_policy_version(
            PolicyArn=policy_arn, VersionId=pol["DefaultVersionId"]
        )["PolicyVersion"]["Document"]
        if isinstance(doc, str):
            doc = json.loads(doc)
        key_arn = _ledger_key_arn()
        required_pci_actions = {
            "kms:generatedatakey*",
            "kms:encrypt",
            "kms:decrypt",
            "kms:reencrypt*",
        }
        destruction_actions = {
            "kms:schedulekeydeletion",
            "kms:disablekey",
            "kms:disablekeyrotation",
        }
        has_pci_deny = False
        has_destruction_deny = False
        for st in doc.get("Statement", []):
            if st.get("Effect") != "Deny":
                continue
            actions = {a.lower() for a in _as_list(st.get("Action"))}
            resources = [r.lower() for r in _as_list(st.get("Resource"))]
            cond = json.dumps(st.get("Condition", {}))
            if (
                required_pci_actions.issubset(actions)
                and (key_arn.lower() in resources or "*" in resources)
                and "aws:PrincipalTag/" in cond
                and BOUNDARY_TAG_KEY in cond
                and BOUNDARY_TAG_VALUE in cond
            ):
                has_pci_deny = True
            if actions & destruction_actions and (
                key_arn.lower() in resources or "*" in resources
            ):
                has_destruction_deny = True
        if not (has_pci_deny and has_destruction_deny):
            return False

        if REGION_BOUNDARY_POLICY:
            region_arn = "arn:aws:iam::%s:policy/%s" % (account, REGION_BOUNDARY_POLICY)
            if region_arn not in attached:
                return False
            rmeta = iam.get_policy(PolicyArn=region_arn)["Policy"]
            rdoc = iam.get_policy_version(
                PolicyArn=region_arn, VersionId=rmeta["DefaultVersionId"]
            )["PolicyVersion"]["Document"]
            if isinstance(rdoc, str):
                rdoc = json.loads(rdoc)
            found_region_deny = False
            for st in rdoc.get("Statement", []):
                if st.get("Effect") != "Deny":
                    continue
                actions = {a.lower() for a in _as_list(st.get("Action"))}
                resources = [r.lower() for r in _as_list(st.get("Resource"))]
                cond_str = json.dumps(st.get("Condition", {})).lower()
                if (
                    required_pci_actions.issubset(actions)
                    and (key_arn.lower() in resources)
                    and "aws:requestedregion" in cond_str
                    and "us-east-2" in cond_str
                ):
                    found_region_deny = True
                    break
            if not found_region_deny:
                return False
        return True
    except Exception:  # noqa: BLE001
        return False


@criterion(
    description="Ledger CMK key policy still gates cryptographic use to tagged principals"
)
def key_policy_scope_intact(workspace: Path) -> bool:
    """The CMK's key policy must not have been opened to '*' or to root without
    a scoping condition. The PrincipalTag Allow may be replaced with any other
    scoping predicate the agent prefers -- the point is that cryptographic use
    is not universally granted."""
    try:
        kms = session.client("kms")
        account = session.client("sts").get_caller_identity()["Account"]
        key_arn = _ledger_key_arn()
        doc = json.loads(
            kms.get_key_policy(KeyId=key_arn, PolicyName="default")["Policy"]
        )
        root = "arn:aws:iam::%s:root" % account
        for st in doc.get("Statement", []):
            if st.get("Effect") != "Allow":
                continue
            principal = st.get("Principal", {})
            principals = []
            if isinstance(principal, str):
                principals = [principal]
            elif isinstance(principal, dict):
                for val in principal.values():
                    principals.extend(_as_list(val))
            actions = {a.lower() for a in _as_list(st.get("Action"))}
            if not (actions & CRYPTO_ACTIONS):
                continue
            if "*" in principals:
                return False
            if root in principals and not st.get("Condition"):
                return False
        return True
    except Exception:  # noqa: BLE001
        return False


@criterion(description="Writer role's KMS crypto grants remain scoped, not blanket")
def identity_grant_is_scoped(workspace: Path) -> bool:
    try:
        docs = _writer_identity_docs()

        def is_scoping_condition(cond) -> bool:
            if not isinstance(cond, dict) or not cond:
                return False
            for _, kv in cond.items():
                if not isinstance(kv, dict):
                    continue
                for k in kv.keys():
                    kl = str(k).lower()
                    if kl == "kms:viaservice":
                        return True
                    if kl.startswith("kms:encryptioncontext"):
                        return True
                    if kl.startswith("aws:resourcetag/"):
                        return True
                    if kl in (
                        "kms:resourcealiases",
                        "kms:callerarn",
                        "kms:granteeprincipal",
                    ):
                        return True
            return False

        wildcard_actions = {"kms:*", "*"}
        for doc in docs:
            if isinstance(doc, str):
                doc = json.loads(doc)
            for st in doc.get("Statement", []):
                if st.get("Effect") != "Allow":
                    continue
                actions = {a.lower() for a in _as_list(st.get("Action"))}
                if not (actions & CRYPTO_ACTIONS):
                    continue
                resources = [str(r).lower() for r in _as_list(st.get("Resource"))]
                has_star_resource = ("*" in resources) or any(
                    r == "arn:aws:kms:*:*:key/*" or r.endswith(":*:key/*")
                    for r in resources
                )
                has_wildcard_action = bool(actions & wildcard_actions)
                if has_star_resource or has_wildcard_action:
                    if not is_scoping_condition(st.get("Condition")):
                        return False
        return True
    except Exception:  # noqa: BLE001
        return False


@criterion(
    description="Writer still uses its own role, the same ledger table and the same CMK"
)
def writer_wiring_unchanged(workspace: Path) -> bool:
    try:
        lam = session.client("lambda")
        ddb = session.client("dynamodb")
        key_arn = _ledger_key_arn()
        cfg = lam.get_function_configuration(FunctionName=WRITER_FN)
        env = cfg.get("Environment", {}).get("Variables", {})
        table = ddb.describe_table(TableName=LEDGER_TABLE)["Table"]
        sse = table.get("SSEDescription", {})
        return all(
            [
                cfg["Role"].endswith("/" + WRITER_ROLE),
                env.get("LEDGER_TABLE_NAME") == LEDGER_TABLE,
                env.get("LEDGER_KMS_KEY_ARN") == key_arn,
                sse.get("Status") == "ENABLED",
                sse.get("SSEType") == "KMS",
                sse.get("KMSMasterKeyArn") == key_arn,
            ]
        )
    except Exception:  # noqa: BLE001
        return False
