"""Pre-invoke for diagnose-rekognition-reupload-stale.

Creates the runtime state the instruction describes: alpha.jpg uploaded once and
processed into DynamoDB, then re-uploaded with different bytes under the same
key, leaving the row holding the first upload's labels. The stack ships the
conditional-putItem bug but deploys an empty bucket and table, so without this
hook there is no object, no row, and no exception log for the agent to find.

Both uploads are synthesized as valid JPEGs whose colour differs, so Rekognition
is exercised on genuinely different bytes. The staleness assertion compares the
row against itself across the second upload rather than against expected label
text, because Rekognition's labels are not stable over time.

Env vars (from ``[pre_invoke.env]`` in task.toml):
    BUCKET_NAME    Bucket the handler watches.
    TABLE_NAME     Table the handler writes.
    FUNCTION_NAME  Handler, used to scope the log search.
    AWS_REGION     Region the stack lives in.
"""

import io
import json
import logging
import os
import sys
import time

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

RESULT_FILE = "/logs/pre_invoke/placeholder.json"

OBJECT_KEY = "alpha.jpg"

# S3 notifications are asynchronous and at-least-once, so every step polls.
ROW_TIMEOUT_SEC = 180
LOG_TIMEOUT_SEC = 180
POLL_INTERVAL_SEC = 5

CONDITIONAL_FAILURE_MARKER = "ConditionalCheckFailedException"


def _jpeg_bytes(rgb: tuple[int, int, int], size: int = 64) -> bytes:
    """Return a solid-colour JPEG that Rekognition accepts as image input."""
    from PIL import Image  # installed by pre_invoke.sh

    buf = io.BytesIO()
    Image.new("RGB", (size, size), rgb).save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def _get_row(ddb, table: str) -> dict | None:
    item = ddb.get_item(
        TableName=table, Key={"image_name": {"S": OBJECT_KEY}}, ConsistentRead=True
    ).get("Item")
    return item


def _wait_for_row(ddb, table: str) -> dict:
    """Poll until the handler has written the alpha.jpg row."""
    deadline = time.monotonic() + ROW_TIMEOUT_SEC
    while time.monotonic() < deadline:
        item = _get_row(ddb, table)
        if item:
            logger.info(f"row present: {item.get('labels', {}).get('S', '')[:120]}")
            return item
        time.sleep(POLL_INTERVAL_SEC)
    raise TimeoutError(
        f"{table} had no {OBJECT_KEY} row after {ROW_TIMEOUT_SEC}s; the S3 "
        f"notification or the handler's first putItem did not complete"
    )


def _wait_for_conditional_failure(logs, function_name: str, since_ms: int) -> None:
    """Poll the handler's log group for a fresh ConditionalCheckFailedException."""
    group = f"/aws/lambda/{function_name}"
    deadline = time.monotonic() + LOG_TIMEOUT_SEC
    while time.monotonic() < deadline:
        try:
            events = logs.filter_log_events(
                logGroupName=group,
                startTime=since_ms,
                filterPattern=f'"{CONDITIONAL_FAILURE_MARKER}"',
            ).get("events", [])
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "ResourceNotFoundException":
                # Group is created on first invocation; keep waiting.
                events = []
            else:
                raise
        if events:
            logger.info(
                f"found {len(events)} fresh {CONDITIONAL_FAILURE_MARKER} event(s)"
            )
            return
        time.sleep(POLL_INTERVAL_SEC)
    raise TimeoutError(
        f"no {CONDITIONAL_FAILURE_MARKER} in {group} within {LOG_TIMEOUT_SEC}s of "
        f"the re-upload; the handler's conditional putItem did not fail as expected"
    )


def run() -> dict[str, str]:
    bucket = os.environ["BUCKET_NAME"]
    table = os.environ["TABLE_NAME"]
    function_name = os.environ["FUNCTION_NAME"]
    region = os.environ["AWS_REGION"]

    s3 = boto3.client("s3", region_name=region)
    ddb = boto3.client("dynamodb", region_name=region)
    logs = boto3.client("logs", region_name=region)

    # Start from a known-clean state so the first upload really is the first.
    s3.delete_object(Bucket=bucket, Key=OBJECT_KEY)
    ddb.delete_item(TableName=table, Key={"image_name": {"S": OBJECT_KEY}})
    logger.info(f"cleared prior {OBJECT_KEY} object and row")

    first = _jpeg_bytes((200, 30, 30))
    s3.put_object(Bucket=bucket, Key=OBJECT_KEY, Body=first, ContentType="image/jpeg")
    logger.info(f"uploaded {OBJECT_KEY} ({len(first)} bytes)")
    row_before = _wait_for_row(ddb, table)

    # Second upload: different bytes, same key. Recorded before the put so the
    # log search cannot match the first invocation.
    reupload_start_ms = int(time.time() * 1000)
    second = _jpeg_bytes((30, 60, 200))
    if second == first:
        raise RuntimeError("re-upload bytes are identical to the first upload")
    s3.put_object(Bucket=bucket, Key=OBJECT_KEY, Body=second, ContentType="image/jpeg")
    logger.info(f"re-uploaded {OBJECT_KEY} ({len(second)} bytes)")

    _wait_for_conditional_failure(logs, function_name, reupload_start_ms)

    # The row must be byte-identical to the pre-re-upload read: that is the
    # staleness the task asks the agent to explain.
    row_after = _get_row(ddb, table)
    if row_after != row_before:
        raise RuntimeError(
            f"{OBJECT_KEY} row changed across the re-upload, so the conditional "
            f"putItem did not block the write: {row_before} -> {row_after}"
        )
    logger.info(f"row unchanged after re-upload; {OBJECT_KEY} is stale as intended")

    return {}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    try:
        placeholders = run()
    except (ClientError, KeyError, RuntimeError, TimeoutError) as e:
        print(f"pre_invoke failed: {e}", file=sys.stderr)
        sys.exit(1)
    os.makedirs(os.path.dirname(RESULT_FILE), exist_ok=True)
    with open(RESULT_FILE, "w") as f:
        json.dump(placeholders, f)
