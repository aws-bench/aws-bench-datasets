"""Seed the DocIntel extraction service: routing profiles + source documents.

Idempotent: every profile row and every sample document is rewritten on each
run, and rows for profiles that no longer exist are removed.
"""

from __future__ import annotations

import json
import time
import urllib.request
from typing import Any, Dict, List, Optional

import boto3
from botocore.exceptions import ClientError

REGION = "us-east-1"
STACK_NAME = "remediation-multiservice-Bedrock-uyvjsf7fj-us-east-1"

# S3 keys holding the router Lambda's captured baseline.
ROUTER_BASELINE_ZIP_KEY = "_baseline/router.zip"
ROUTER_BASELINE_MANIFEST_KEY = "_baseline/manifest.json"

INVOICE_SCHEMA = {
    "type": "object",
    "properties": {
        "invoice_number": {
            "type": "string",
            "description": "Supplier invoice identifier",
        },
        "supplier_name": {"type": "string"},
        "invoice_date": {"type": "string", "description": "ISO-8601 date"},
        "currency": {"type": "string", "description": "ISO-4217 currency code"},
        "total_amount": {"type": "number"},
        "tax_amount": {"type": "number"},
        "purchase_order_ref": {"type": "string"},
    },
    "required": ["invoice_number", "supplier_name", "currency", "total_amount"],
}

CONTRACT_SCHEMA = {
    "type": "object",
    "properties": {
        "counterparty": {"type": "string"},
        "agreement_type": {"type": "string"},
        "effective_date": {"type": "string"},
        "term_months": {"type": "number"},
        "auto_renew": {"type": "boolean"},
        "governing_law": {"type": "string"},
        "notice_period_days": {"type": "number"},
    },
    "required": ["counterparty", "agreement_type", "effective_date", "term_months"],
}

RECEIPT_SCHEMA = {
    "type": "object",
    "properties": {
        "merchant": {"type": "string"},
        "transaction_date": {"type": "string"},
        "currency": {"type": "string"},
        "total_amount": {"type": "number"},
        "expense_category": {"type": "string"},
        "payment_last4": {"type": "string"},
    },
    "required": ["merchant", "transaction_date", "currency", "total_amount"],
}

REMITTANCE_SCHEMA = {
    "type": "object",
    "properties": {
        "payer": {"type": "string"},
        "payment_reference": {"type": "string"},
        "payment_date": {"type": "string"},
        "currency": {"type": "string"},
        "total_paid": {"type": "number"},
        "invoice_count": {"type": "number"},
    },
    "required": ["payer", "payment_reference", "currency", "total_paid"],
}

STATEMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "account_holder": {"type": "string"},
        "account_last4": {"type": "string"},
        "statement_period_start": {"type": "string"},
        "statement_period_end": {"type": "string"},
        "closing_balance": {"type": "number"},
        "currency": {"type": "string"},
    },
    "required": ["account_holder", "statement_period_start", "closing_balance"],
}

PO_SCHEMA = {
    "type": "object",
    "properties": {
        "po_number": {"type": "string"},
        "buyer": {"type": "string"},
        "vendor": {"type": "string"},
        "order_date": {"type": "string"},
        "currency": {"type": "string"},
        "total_amount": {"type": "number"},
        "line_item_count": {"type": "number"},
    },
    "required": ["po_number", "buyer", "vendor", "total_amount"],
}

FAX_SCHEMA = {
    "type": "object",
    "properties": {
        "sender": {"type": "string"},
        "received_date": {"type": "string"},
        "subject": {"type": "string"},
        "page_count": {"type": "number"},
    },
    "required": ["sender", "subject"],
}

# Every class shares one handler; only modelId and routingStrategy differ.
PROFILES: List[Dict[str, Any]] = [
    {
        "profileId": "contracts_v4",
        "documentClass": "msa_contract",
        "modelId": "amazon.nova-pro-v1:0",
        "toolName": "record_contract_terms",
        "toolDescription": "Record the negotiated terms extracted from a master services agreement.",
        "routingStrategy": "strict",
        "toolSchema": json.dumps(CONTRACT_SCHEMA),
        "sampleKey": "samples/contracts_v4.txt",
        "promptPreamble": "You are a contract abstraction service. Extract the requested agreement terms.",
        "maxTokens": 700,
        "temperature": "0",
        "owner": "legal-ops",
        "enabled": True,
    },
    {
        "profileId": "contracts_v5",
        "documentClass": "msa_contract",
        "modelId": "amazon.nova-pro-v1:0",
        "toolName": "record_contract_terms",
        "toolDescription": "Record the negotiated terms extracted from a master services agreement.",
        "routingStrategy": "open",
        "toolSchema": json.dumps(CONTRACT_SCHEMA),
        "sampleKey": "samples/contracts_v5.txt",
        "promptPreamble": "You are a contract abstraction service. Extract the requested agreement terms.",
        "maxTokens": 700,
        "temperature": "0",
        "owner": "legal-ops",
        "enabled": True,
    },
    {
        "profileId": "invoices_v7",
        "documentClass": "supplier_invoice",
        "modelId": "us.meta.llama3-3-70b-instruct-v1:0",
        "toolName": "record_invoice_fields",
        "toolDescription": "Record the structured header fields of a supplier invoice.",
        "routingStrategy": "strict",
        "toolSchema": json.dumps(INVOICE_SCHEMA),
        "sampleKey": "samples/invoices_v7.txt",
        "promptPreamble": "You are an accounts-payable extraction service. Extract the invoice header fields.",
        "maxTokens": 600,
        "temperature": "0",
        "owner": "ap-automation",
        "enabled": True,
    },
    {
        "profileId": "purchase_orders_v2",
        "documentClass": "purchase_order",
        "modelId": "amazon.nova-lite-v1:0",
        "toolName": "record_po_fields",
        "toolDescription": "Record the structured header fields of a purchase order.",
        "routingStrategy": "strict",
        "toolSchema": json.dumps(PO_SCHEMA),
        "sampleKey": "samples/purchase_orders_v2.txt",
        "promptPreamble": "You are a procurement extraction service. Extract the purchase order header fields.",
        "maxTokens": 600,
        "temperature": "0",
        "owner": "procurement-eng",
        "enabled": True,
    },
    {
        "profileId": "receipts_v2",
        "documentClass": "expense_receipt",
        "modelId": "mistral.mistral-large-2402-v1:0",
        "toolName": "record_receipt_fields",
        "toolDescription": "Record the structured fields of an employee expense receipt.",
        "routingStrategy": "strict",
        "toolSchema": json.dumps(RECEIPT_SCHEMA),
        "sampleKey": "samples/receipts_v2.txt",
        "promptPreamble": "You are an expense processing service. Extract the receipt fields.",
        "maxTokens": 500,
        "temperature": "0",
        "owner": "travel-expense",
        "enabled": True,
    },
    {
        "profileId": "receipts_v3",
        "documentClass": "expense_receipt",
        "modelId": "mistral.mistral-large-2402-v1:0",
        "toolName": "record_receipt_fields",
        "toolDescription": "Record the structured fields of an employee expense receipt.",
        "routingStrategy": "strict",
        "toolSchema": json.dumps(RECEIPT_SCHEMA),
        "sampleKey": "samples/receipts_v3.txt",
        "promptPreamble": "You are an expense processing service. Extract the receipt fields.",
        "maxTokens": 500,
        "temperature": "0",
        "owner": "travel-expense",
        "enabled": False,
    },
    {
        "profileId": "remittance_v1",
        "documentClass": "remittance_advice",
        "modelId": "mistral.mistral-large-2402-v1:0",
        "toolName": "record_remittance_fields",
        "toolDescription": "Record the structured fields of a customer remittance advice.",
        "routingStrategy": "open",
        "toolSchema": json.dumps(REMITTANCE_SCHEMA),
        "sampleKey": "samples/remittance_v1.txt",
        "promptPreamble": "You are a cash-application service. Extract the remittance advice fields.",
        "maxTokens": 500,
        "temperature": "0",
        "owner": "ar-automation",
        "enabled": True,
    },
    {
        "profileId": "statements_v3",
        "documentClass": "bank_statement",
        "modelId": "us.meta.llama3-3-70b-instruct-v1:0",
        "toolName": "record_statement_fields",
        "toolDescription": "Record the structured header fields of a bank statement.",
        "routingStrategy": "open",
        "toolSchema": json.dumps(STATEMENT_SCHEMA),
        "sampleKey": "samples/statements_v3.txt",
        "promptPreamble": "You are a treasury reconciliation service. Extract the statement header fields.",
        "maxTokens": 600,
        "temperature": "0",
        "owner": "treasury-eng",
        "enabled": True,
    },
    {
        "profileId": "legacy_faxes_v1",
        "documentClass": "scanned_fax",
        "modelId": "us.deepseek.r1-v1:0",
        "toolName": "record_fax_fields",
        "toolDescription": "Record the cover-sheet metadata of a scanned inbound fax.",
        "routingStrategy": "auto",
        "toolSchema": json.dumps(FAX_SCHEMA),
        "sampleKey": "samples/legacy_faxes_v1.txt",
        "promptPreamble": "You are a records digitisation service. Extract the fax cover sheet metadata.",
        "maxTokens": 400,
        "temperature": "0",
        "owner": "records-mgmt",
        "enabled": False,
    },
]

DOCUMENTS: Dict[str, str] = {
    "samples/contracts_v4.txt": """MASTER SERVICES AGREEMENT

This Master Services Agreement ("Agreement") is entered into as of 2025-02-14
between Northwind Logistics Group Ltd. ("Customer") and Meridian Cloud Services
Inc. ("Provider").

1. TERM. The initial term of this Agreement is thirty-six (36) months from the
   Effective Date and shall automatically renew for successive twelve (12) month
   periods unless either party gives written notice of non-renewal at least
   ninety (90) days prior to the end of the then-current term.

2. FEES. Customer shall pay the fees set out in each Statement of Work. Invoices
   are due net 45 days from receipt.

3. GOVERNING LAW. This Agreement is governed by the laws of the State of
   Delaware, excluding its conflict of law rules.

4. SERVICE LEVELS. Provider will maintain 99.9% monthly availability for the
   managed extraction platform described in SOW-2025-018.
""",
    "samples/invoices_v7.txt": """VERTEX INDUSTRIAL SUPPLY CO.
1188 Harbour Point Road, Rotterdam
VAT: NL823447192B01

INVOICE

Invoice No:      INV-2025-0088213
Invoice Date:    2025-03-04
Customer:        Northwind Logistics Group Ltd.
PO Reference:    PO-44219-B
Payment Terms:   Net 30

Line items
  1. Conveyor drive belt, 1200mm          6 x   412.50   =  2475.00
  2. Bearing housing assembly SKF-2214    4 x   188.75   =   755.00
  3. Freight and handling                 1 x    98.40   =    98.40

Subtotal                                              3328.40
VAT 21%                                                698.96
TOTAL DUE  EUR                                        4027.36
""",
    "samples/purchase_orders_v2.txt": """PURCHASE ORDER

PO Number:    PO-44219-B
Order Date:   2025-02-26
Buyer:        Northwind Logistics Group Ltd. (Rotterdam DC)
Vendor:       Vertex Industrial Supply Co.
Currency:     EUR
Incoterms:    DAP Rotterdam
Requested delivery: 2025-03-12

Lines
  10  Conveyor drive belt, 1200mm            qty 6    unit 412.50
  20  Bearing housing assembly SKF-2214      qty 4    unit 188.75
  30  Freight and handling                   qty 1    unit  98.40

Order total (excl. VAT): 3328.40 EUR
Approved by: J. Okonkwo, Category Manager
""",
    "samples/receipts_v2.txt": """CAFE ORIOLE
221 Kloveniersburgwal, Amsterdam
Terminal 04  /  Ticket 118837

Date: 2025-03-11  19:42

  2 x Espresso                      5.60
  1 x Club sandwich                12.50
  1 x Sparkling water               3.20

Subtotal                           21.30
BTW 9%                              1.92
TOTAL EUR                          23.22

Paid by card VISA **** 4417
Expense category: Meals - client entertainment
Employee: R. Castellanos (emp 20881)
""",
    "samples/contracts_v5.txt": """MASTER SERVICES AGREEMENT

This Master Services Agreement ("Agreement") is entered into as of 2025-04-02
between Halberd Retail Holdings PLC ("Customer") and Meridian Cloud Services
Inc. ("Provider").

1. TERM. The initial term of this Agreement is twenty-four (24) months from the
   Effective Date and shall automatically renew for successive twelve (12) month
   periods unless either party gives written notice of non-renewal at least
   sixty (60) days prior to the end of the then-current term.

2. FEES. Customer shall pay the fees set out in each Statement of Work. Invoices
   are due net 30 days from receipt.

3. GOVERNING LAW. This Agreement is governed by the laws of England and Wales,
   excluding its conflict of law rules.

4. SERVICE LEVELS. Provider will maintain 99.95% monthly availability for the
   managed extraction platform described in SOW-2025-042.
""",
    "samples/receipts_v3.txt": """CAFE ORIOLE
221 Kloveniersburgwal, Amsterdam
Terminal 07  /  Ticket 118921

Date: 2025-03-14  13:04

  1 x Espresso                      2.80
  1 x Bitterballen (6)              8.90
  1 x Sparkling water               3.20

Subtotal                           14.90
BTW 9%                              1.34
TOTAL EUR                          16.24

Paid by card VISA **** 4417
Expense category: Meals - client entertainment
Employee: R. Castellanos (emp 20881)
""",
    "samples/remittance_v1.txt": """REMITTANCE ADVICE

From:            Halberd Retail Holdings PLC
Payment Ref:     ACH-2025-0311-77401
Payment Date:    2025-03-11
Currency:        GBP
Method:          Bacs credit

Settled invoices
  INV-2025-0081990    1,240.00
  INV-2025-0082114      880.50
  INV-2025-0082377    2,015.75
  INV-2025-0082901      664.00

Total paid GBP    4,800.25

Queries: ap.enquiries@halberd-retail.example
""",
    "samples/statements_v3.txt": """MERIDIAN COMMERCIAL BANK
Business Current Account Statement

Account holder:   Northwind Logistics Group Ltd.
Account number:   ****6642
Currency:         EUR
Statement period: 2025-02-01 to 2025-02-28

Opening balance                              182,440.19

  2025-02-03  Card settlement batch           -12,004.55
  2025-02-07  Incoming ACH Halberd Retail      48,200.00
  2025-02-14  Payroll run 2025-02             -96,318.40
  2025-02-21  Supplier payment run            -31,772.08
  2025-02-27  Interest credit                     412.66

Closing balance                               90,957.82
""",
    "samples/legacy_faxes_v1.txt": """FAX COVER SHEET

To:        Records Management, Northwind Logistics Group Ltd.
From:      Bureau Veritas Inspection Services
Date:      2025-01-19
Subject:   Container inspection certificate CIC-88420 (re: booking NWL-5512)
Pages:     4 (including cover)

Please file the attached inspection certificate against booking NWL-5512.
Original hard copy has been posted separately.
""",
}


def _stack_outputs(session: boto3.Session, region: str) -> Dict[str, str]:
    cfn = session.client("cloudformation", region_name=region)
    stacks = cfn.describe_stacks(StackName=STACK_NAME)["Stacks"]
    return {o["OutputKey"]: o["OutputValue"] for o in stacks[0].get("Outputs", [])}


def _capture_router_baseline(
    session: boto3.Session,
    region: str,
    function_name: str,
    bucket: str,
    profile_records: List[Dict[str, Any]],
) -> None:
    """Persist the router Lambda's deployed baseline (code archive, env vars,
    role, plus the seeded profile rows) to a stable S3 location.

    Never overwrites: if a baseline manifest already exists, it is left alone.
    Delete both baseline objects to force a recapture.
    """
    s3 = session.client("s3", region_name=region)
    lam = session.client("lambda", region_name=region)

    try:
        s3.head_object(Bucket=bucket, Key=ROUTER_BASELINE_MANIFEST_KEY)
        print(
            f"router baseline already present at s3://{bucket}/{ROUTER_BASELINE_MANIFEST_KEY}"
            " — preserving first-run capture (delete both baseline objects to force recapture)"
        )
        return
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") not in (
            "404",
            "NoSuchKey",
            "NotFound",
        ):
            raise

    fn = lam.get_function(FunctionName=function_name)
    cfg = fn.get("Configuration", {}) or {}
    code_sha = cfg.get("CodeSha256", "")
    code_url = (fn.get("Code", {}) or {}).get("Location", "")
    env_vars = (cfg.get("Environment", {}) or {}).get("Variables", {}) or {}
    role_arn = cfg.get("Role", "")

    if not code_url:
        raise RuntimeError(f"router Lambda {function_name} has no Code.Location")

    # Code.Location is a pre-signed URL valid for ~10 minutes.
    with urllib.request.urlopen(code_url, timeout=60) as resp:
        zip_bytes = resp.read()

    s3.put_object(
        Bucket=bucket,
        Key=ROUTER_BASELINE_ZIP_KEY,
        Body=zip_bytes,
        ContentType="application/zip",
        ServerSideEncryption="AES256",
    )

    captured_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    manifest = {
        "capturedAt": captured_at,
        "functionName": function_name,
        "codeSha256": code_sha,
        "codeS3Bucket": bucket,
        "codeS3Key": ROUTER_BASELINE_ZIP_KEY,
        "environment": env_vars,
        "roleArn": role_arn,
        "profiles": profile_records,
    }
    s3.put_object(
        Bucket=bucket,
        Key=ROUTER_BASELINE_MANIFEST_KEY,
        Body=json.dumps(manifest, indent=2, default=str).encode("utf-8"),
        ContentType="application/json",
        ServerSideEncryption="AES256",
    )
    print(
        f"captured router baseline: sha={code_sha}, archive={len(zip_bytes)} bytes, "
        f"{len(env_vars)} env vars, {len(profile_records)} profile rows -> "
        f"s3://{bucket}/{ROUTER_BASELINE_ZIP_KEY} + {ROUTER_BASELINE_MANIFEST_KEY}"
    )


def run(session: Optional[boto3.Session] = None, region: str = REGION, **kwargs):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY")

    outputs = _stack_outputs(session, region)
    bucket = outputs["DocumentsBucketName"]
    profiles_table = outputs["ProfilesTableName"]
    function_name = outputs.get("FunctionName", "")

    s3 = session.client("s3", region_name=region)
    ddb = session.resource("dynamodb", region_name=region)
    table = ddb.Table(profiles_table)

    # 1. Source documents
    for key, body in DOCUMENTS.items():
        s3.put_object(
            Bucket=bucket,
            Key=key,
            Body=body.encode("utf-8"),
            ContentType="text/plain; charset=utf-8",
            ServerSideEncryption="AES256",
        )
    print(f"uploaded {len(DOCUMENTS)} sample documents to s3://{bucket}/samples/")

    # 2. Routing profiles (delete-then-insert so the table converges)
    wanted = {p["profileId"] for p in PROFILES}
    existing = set()
    scan_kwargs: Dict[str, Any] = {"ProjectionExpression": "profileId"}
    while True:
        page = table.scan(**scan_kwargs)
        existing.update(i["profileId"] for i in page.get("Items", []))
        if "LastEvaluatedKey" not in page:
            break
        scan_kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    for stale in existing - wanted:
        table.delete_item(Key={"profileId": stale})
        print(f"removed stale profile {stale}")

    updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    profile_records: List[Dict[str, Any]] = []
    with table.batch_writer() as batch:
        for profile in PROFILES:
            item = dict(profile)
            item["updatedAt"] = updated_at
            item["schemaVersion"] = 3
            batch.put_item(Item=item)
            profile_records.append(item)
    print(f"seeded {len(PROFILES)} extraction profiles into {profiles_table}")

    # 3. Capture the router-Lambda baseline.
    if function_name:
        try:
            _capture_router_baseline(
                session, region, function_name, bucket, profile_records
            )
        except (ClientError, urllib.error.URLError, OSError, RuntimeError) as exc:
            # Setup must not fail when baseline capture hits a transient issue.
            print(f"warning: failed to capture router baseline: {exc}")
    else:
        print(
            "warning: FunctionName not exported by stack; skipping router baseline capture"
        )


if __name__ == "__main__":
    run()
