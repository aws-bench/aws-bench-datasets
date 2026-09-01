"""Ledger writer -- persists card transactions with field-level envelope encryption.

Sensitive PAN data is wrapped with a data key generated from the ledger CMK before
the record is written to DynamoDB (the table itself is also encrypted at rest with
the same customer managed key).
"""

import base64
import hashlib
import hmac
import json
import logging
import os
import time

import boto3
from botocore.exceptions import ClientError

LOG = logging.getLogger()
LOG.setLevel(logging.INFO)

TABLE_NAME = os.environ["LEDGER_TABLE_NAME"]
KEY_ARN = os.environ["LEDGER_KMS_KEY_ARN"]
QUEUE_URL = os.environ["FAILED_RECORDS_QUEUE_URL"]
WRITER_VERSION = os.environ.get("WRITER_VERSION", "2.4.1")

_ddb = boto3.client("dynamodb")
_kms = boto3.client("kms")
_sqs = boto3.client("sqs")


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
    """Envelope-encrypt one field: KMS data key wraps the local keystream."""
    dk = _kms.generate_data_key(
        KeyId=KEY_ARN,
        KeySpec="AES_256",
        EncryptionContext={"table": TABLE_NAME, "accountId": account_id},
    )
    raw = plaintext.encode("utf-8")
    ciphertext = _xor(raw, _keystream(dk["Plaintext"], len(raw)))
    return (
        base64.b64encode(ciphertext).decode("ascii"),
        base64.b64encode(dk["CiphertextBlob"]).decode("ascii"),
    )


def handler(event, context):
    records = event.get("records") or [event]
    written = []

    for rec in records:
        account_id = str(rec["accountId"])
        txn_id = str(rec["txnId"])
        try:
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
                    "writtenAt": {"N": str(int(time.time()))},
                    "writerVersion": {"S": WRITER_VERSION},
                },
            )
            written.append(txn_id)
            LOG.info("ledger.persisted table=%s txn=%s", TABLE_NAME, txn_id)
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "Unknown")
            req_id = exc.response.get("ResponseMetadata", {}).get("RequestId", "-")
            # Application only records the error code, not the provider message.
            LOG.error(
                "ledger.persist_failed table=%s txn=%s error_code=%s aws_request_id=%s",
                TABLE_NAME,
                txn_id,
                code,
                req_id,
            )
            try:
                _sqs.send_message(
                    QueueUrl=QUEUE_URL,
                    MessageBody=json.dumps(
                        {
                            "txnId": txn_id,
                            "accountId": account_id,
                            "table": TABLE_NAME,
                            "errorCode": code,
                            "writerVersion": WRITER_VERSION,
                            "failedAt": int(time.time()),
                        }
                    ),
                )
            except ClientError:
                LOG.error("ledger.failed_record_publish_failed txn=%s", txn_id)
            raise RuntimeError(
                "unable to persist transaction %s to DynamoDB table %s: %s"
                % (txn_id, TABLE_NAME, code)
            ) from None

    return {"statusCode": 200, "written": written, "table": TABLE_NAME}
