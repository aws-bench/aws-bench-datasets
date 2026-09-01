"""Seed the payments ledger platform with production-shaped data.

Runs once after `cdk deploy`. Idempotent: every write is a deterministic put_item
(or a backfill invocation with fixed transaction ids), so re-running converges.
"""

import json
import random
import time
from typing import Optional

import boto3

REGION = "us-east-1"
STACK_NAME = "remediation-multiservice-Ledger-qxoqk9o4y-us-east-1"

MERCHANTS = [
    ("MRC-ATLAS-AIRLINES", "Atlas Airlines"),
    ("MRC-NORTHWIND-FUEL", "Northwind Fuel"),
    ("MRC-BLUEPEAK-GROCER", "Bluepeak Grocer"),
    ("MRC-HELIOS-HOTELS", "Helios Hotels"),
    ("MRC-CEDAR-PHARMACY", "Cedar Pharmacy"),
]
CURRENCIES = ["USD", "USD", "USD", "EUR", "GBP"]


def _outputs(cfn, stack_name: str) -> dict:
    resp = cfn.describe_stacks(StackName=stack_name)
    return {
        o["OutputKey"]: o["OutputValue"] for o in resp["Stacks"][0].get("Outputs", [])
    }


def _historical_transactions(count: int = 48):
    rnd = random.Random(20240517)
    now = int(time.time())
    records = []
    for i in range(count):
        merchant_id, _label = MERCHANTS[i % len(MERCHANTS)]
        account_no = "4%015d" % (411100000000000 + i * 7919)
        records.append(
            {
                "accountId": "ACC-%06d" % (1000 + (i % 12)),
                "txnId": "TXN-HIST-%05d" % i,
                "accountNumber": account_no,
                "amountMinor": rnd.randint(499, 249900),
                "currency": CURRENCIES[i % len(CURRENCIES)],
                "merchant": merchant_id,
                "status": "POSTED" if i % 9 else "REVERSED",
                "writtenAt": now - (86400 * (1 + (i % 21))),
            }
        )
    return records


def _seed_ledger(lam, fn_name: str, records) -> int:
    """Load the ledger through the correctly-authorised backfill job.

    Retries on transient failures: IAM role tags, key policy principals and KMS
    grants can take a short while to become effective right after stack creation.
    """
    loaded = 0
    for start in range(0, len(records), 12):
        batch = records[start : start + 12]
        last = None
        for attempt in range(8):
            resp = lam.invoke(
                FunctionName=fn_name,
                InvocationType="RequestResponse",
                Payload=json.dumps({"records": batch}).encode("utf-8"),
            )
            last = json.loads(resp["Payload"].read() or b"{}")
            if not resp.get("FunctionError"):
                loaded += int(last.get("loaded", 0))
                break
            time.sleep(15 if attempt < 7 else 0)
        else:
            raise RuntimeError("backfill invocation failed: %s" % last)
    return loaded


def _seed_audit(ddb, table_name: str) -> int:
    rnd = random.Random(777)
    now = int(time.time())
    actors = [
        "ledger-writer",
        "ledger-reader",
        "ledger-backfill",
        "pci-compliance-scanner",
    ]
    written = 0
    for i in range(32):
        emitted = now - (3600 * (i + 1))
        ddb.put_item(
            TableName=table_name,
            Item={
                "eventId": {"S": "EVT-%05d" % i},
                "emittedAt": {"N": str(emitted)},
                "actor": {"S": actors[i % len(actors)]},
                "action": {"S": "ledger.write" if i % 3 else "ledger.read"},
                "outcome": {"S": "SUCCEEDED" if i % 5 else "DENIED"},
                "resource": {"S": "ledger-transactions"},
                "correlationId": {"S": "corr-%08x" % rnd.getrandbits(32)},
            },
        )
        written += 1
    return written


def _seed_analytics(ddb, table_name: str) -> int:
    rnd = random.Random(31337)
    written = 0
    periods = ["2024-04", "2024-05", "2024-06", "2024-07"]
    for merchant_id, label in MERCHANTS:
        for period in periods:
            ddb.put_item(
                TableName=table_name,
                Item={
                    "merchantId": {"S": merchant_id},
                    "period": {"S": period},
                    "merchantName": {"S": label},
                    "grossMinor": {"N": str(rnd.randint(120000, 9800000))},
                    "refundMinor": {"N": str(rnd.randint(0, 90000))},
                    "txnCount": {"N": str(rnd.randint(40, 5200))},
                },
            )
            written += 1
    return written


BOUNDARY_TAG_KEY = "x-27f3b8"
BOUNDARY_TAG_VALUE = "Q4"
KEY_SCOPE_TAG_KEY = "x-58b1d9"
KEY_SCOPE_TAG_VALUE = "H"

SSM_TAG_SCHEMA_PATH = "/platform/ledger/%s/tag-schema" % "qxoqk9o4y"


def _publish_tag_schema(ssm) -> None:
    """Publish the principal-tag keys and values the boundary and key policies require."""
    body = {
        "boundary": {"key": BOUNDARY_TAG_KEY, "value": BOUNDARY_TAG_VALUE},
        "key_policy": {"key": KEY_SCOPE_TAG_KEY, "value": KEY_SCOPE_TAG_VALUE},
    }
    ssm.put_parameter(
        Name=SSM_TAG_SCHEMA_PATH,
        Description="Ledger PCI CMK principal-tag schema (opaque data-scope tags).",
        Value=json.dumps(body),
        Type="String",
        Overwrite=True,
    )


def _neutralise_backfill_diff(iam, backfill_role: str) -> None:
    """Remove both of the backfill role's data-scope tags after seeding."""
    try:
        iam.untag_role(
            RoleName=backfill_role, TagKeys=[BOUNDARY_TAG_KEY, KEY_SCOPE_TAG_KEY]
        )
    except Exception:
        pass


def run(session: Optional[boto3.Session] = None, region: str = REGION, **kwargs):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY")

    cfn = session.client("cloudformation", region_name=region)
    ddb = session.client("dynamodb", region_name=region)
    lam = session.client("lambda", region_name=region)
    ssm = session.client("ssm", region_name=region)
    iam = session.client("iam")

    out = _outputs(cfn, STACK_NAME)
    ledger_table = out["LedgerTableName"]
    audit_table = out["AuditTableName"]
    analytics_table = out["AnalyticsTableName"]
    backfill_fn = out["BackfillFunctionName"]
    backfill_role = out["BackfillRoleName"]
    reconciler_fn = out["ReconcilerFunctionName"]

    # 0. Re-tag the backfill role. Step 5 strips these tags, and CloudFormation
    # does not re-apply tags without a stack diff, so a re-run starts stripped.
    iam.tag_role(
        RoleName=backfill_role,
        Tags=[
            {"Key": BOUNDARY_TAG_KEY, "Value": BOUNDARY_TAG_VALUE},
            {"Key": KEY_SCOPE_TAG_KEY, "Value": KEY_SCOPE_TAG_VALUE},
        ],
    )

    # 1. historical ledger rows, written through the correctly-authorised backfill job
    records = _historical_transactions()
    loaded = _seed_ledger(lam, backfill_fn, records)
    if loaded != len(records):
        raise RuntimeError("backfill loaded %d of %d records" % (loaded, len(records)))

    # 2. audit trail + analytics aggregates
    audit_rows = _seed_audit(ddb, audit_table)
    analytics_rows = _seed_analytics(ddb, analytics_table)

    # 3. produce the nightly report so the analytics path has real artefacts
    resp = lam.invoke(
        FunctionName=reconciler_fn, InvocationType="RequestResponse", Payload=b"{}"
    )
    payload = json.loads(resp["Payload"].read() or b"{}")
    if resp.get("FunctionError"):
        raise RuntimeError("reconciler invocation failed: %s" % payload)

    # 4. confirm the ledger is queryable before declaring success
    deadline = time.time() + 180
    while time.time() < deadline:
        scanned = ddb.scan(TableName=ledger_table, Select="COUNT")["Count"]
        if scanned >= len(records):
            break
        time.sleep(5)
    else:
        raise RuntimeError("ledger table did not converge to %d rows" % len(records))

    # 5. publish the tag schema and strip the backfill role's tags
    _publish_tag_schema(ssm)
    _neutralise_backfill_diff(iam, backfill_role)

    print(
        "seeded ledger=%d audit=%d analytics=%d report=%s"
        % (loaded, audit_rows, analytics_rows, payload.get("reportKey"))
    )


if __name__ == "__main__":
    run()
