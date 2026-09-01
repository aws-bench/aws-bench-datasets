"""Ledger backfill job -- bulk loads historical transactions with the same
field-level envelope encryption scheme used by the online writer.
"""

import base64
import hashlib
import hmac
import logging
import os
import time

import boto3

LOG = logging.getLogger()
LOG.setLevel(logging.INFO)

TABLE_NAME = os.environ["LEDGER_TABLE_NAME"]
KEY_ARN = os.environ["LEDGER_KMS_KEY_ARN"]
JOB_VERSION = os.environ.get("BACKFILL_VERSION", "1.9.0")

_ddb = boto3.client("dynamodb")
_kms = boto3.client("kms")


def _keystream(key: bytes, nbytes: int) -> bytes:
    out = b""
    counter = 0
    while len(out) < nbytes:
        out += hmac.new(key, counter.to_bytes(8, "big"), hashlib.sha256).digest()
        counter += 1
    return out[:nbytes]


def _xor(data: bytes, stream: bytes) -> bytes:
    return bytes(a ^ b for a, b in zip(data, stream))


def _encrypt_field(account_id: str, plaintext: str):
    dk = _kms.generate_data_key(
        KeyId=KEY_ARN,
        KeySpec="AES_256",
        EncryptionContext={"table": TABLE_NAME, "accountId": account_id},
    )
    raw = plaintext.encode("utf-8")
    return (
        base64.b64encode(_xor(raw, _keystream(dk["Plaintext"], len(raw)))).decode(
            "ascii"
        ),
        base64.b64encode(dk["CiphertextBlob"]).decode("ascii"),
    )


def handler(event, context):
    records = event.get("records") or []
    loaded = []
    for rec in records:
        account_id = str(rec["accountId"])
        txn_id = str(rec["txnId"])
        enc_pan, wrapped_key = _encrypt_field(account_id, str(rec["accountNumber"]))
        _ddb.put_item(
            TableName=TABLE_NAME,
            Item={
                "accountId": {"S": account_id},
                "txnId": {"S": txn_id},
                "accountNumberEnc": {"S": enc_pan},
                "dataKeyCiphertext": {"S": wrapped_key},
                "amountMinor": {"N": str(int(rec.get("amountMinor", 0)))},
                "currency": {"S": str(rec.get("currency", "USD"))},
                "merchant": {"S": str(rec.get("merchant", "unknown"))},
                "status": {"S": str(rec.get("status", "POSTED"))},
                "writtenAt": {"N": str(int(rec.get("writtenAt", int(time.time()))))},
                "writerVersion": {"S": "backfill-" + JOB_VERSION},
            },
        )
        loaded.append(txn_id)
    LOG.info("ledger.backfill_complete table=%s count=%d", TABLE_NAME, len(loaded))
    return {"statusCode": 200, "loaded": len(loaded), "table": TABLE_NAME}
