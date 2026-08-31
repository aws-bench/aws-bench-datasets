"""Ledger reader -- fetches a transaction and decrypts the PAN field, returning last4."""

import base64
import hashlib
import hmac
import logging
import os

import boto3
from botocore.exceptions import ClientError

LOG = logging.getLogger()
LOG.setLevel(logging.INFO)

TABLE_NAME = os.environ["LEDGER_TABLE_NAME"]

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


def handler(event, context):
    account_id = str(event["accountId"])
    txn_id = str(event["txnId"])

    resp = _ddb.get_item(
        TableName=TABLE_NAME,
        Key={"accountId": {"S": account_id}, "txnId": {"S": txn_id}},
        ConsistentRead=True,
    )
    item = resp.get("Item")
    if not item:
        LOG.info("ledger.read_miss table=%s txn=%s", TABLE_NAME, txn_id)
        return {"statusCode": 404, "found": False, "txnId": txn_id}

    try:
        dk = _kms.decrypt(
            CiphertextBlob=base64.b64decode(item["dataKeyCiphertext"]["S"]),
            EncryptionContext={"table": TABLE_NAME, "accountId": account_id},
        )
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "Unknown")
        LOG.error(
            "ledger.decrypt_failed table=%s txn=%s error_code=%s",
            TABLE_NAME,
            txn_id,
            code,
        )
        return {"statusCode": 500, "found": True, "decrypted": False, "errorCode": code}

    ciphertext = base64.b64decode(item["accountNumberEnc"]["S"])
    pan = _xor(ciphertext, _keystream(dk["Plaintext"], len(ciphertext))).decode("utf-8")

    LOG.info("ledger.read_ok table=%s txn=%s", TABLE_NAME, txn_id)
    return {
        "statusCode": 200,
        "found": True,
        "decrypted": True,
        "txnId": txn_id,
        "accountId": account_id,
        "accountNumberLast4": pan[-4:],
        "amountMinor": int(item["amountMinor"]["N"]),
        "currency": item["currency"]["S"],
        "status": item["status"]["S"],
    }
