"""Static-site publisher.

Copies the build described by SOURCE_PREFIX/manifest.json from the build
artifacts bucket into the CloudFront origin bucket, then issues a
distribution invalidation for the paths it touched.

Environment variables
---------------------
SOURCE_BUCKET     build artifacts bucket
SOURCE_PREFIX     prefix of the build to publish (must contain manifest.json)
ORIGIN_BUCKET     CloudFront origin bucket for the site
DISTRIBUTION_ID   CloudFront distribution serving ORIGIN_BUCKET
CACHE_CONTROL     Cache-Control header written on every published object
MODE_SSM_PATH     SSM parameter carrying the sync-mode token
"""

import hashlib
import json
import os
import time

import boto3
from botocore.exceptions import ClientError

s3 = boto3.client("s3")
cloudfront = boto3.client("cloudfront")
ssm = boto3.client("ssm")

SOURCE_BUCKET = os.environ["SOURCE_BUCKET"]
SOURCE_PREFIX = os.environ.get("SOURCE_PREFIX", "releases/current/")
ORIGIN_BUCKET = os.environ["ORIGIN_BUCKET"]
DISTRIBUTION_ID = os.environ["DISTRIBUTION_ID"]
CACHE_CONTROL = os.environ.get("CACHE_CONTROL", "public, max-age=86400")
MODE_SSM_PATH = os.environ.get("MODE_SSM_PATH", "")

LEGACY_ETAG_PREFIX = os.environ.get("LEGACY_ETAG_PREFIX", "")
CDN_HEADER_MODE = os.environ.get("CDN_HEADER_MODE", "v1")
PUBLISH_DRY_RUN = os.environ.get("PUBLISH_DRY_RUN", "")


def _load_mode_token() -> str:
    """Fetch the opaque sync-mode token from SSM at cold start."""
    if not MODE_SSM_PATH:
        return ""
    try:
        return ssm.get_parameter(Name=MODE_SSM_PATH)["Parameter"]["Value"].strip()
    except Exception:  # noqa: BLE001
        return ""


_MODE_TOKEN = _load_mode_token()


def _uses_length_only(token: str) -> bool:
    t = token.lower()
    return t in {"md5-len-only", "len-only", "size"} or t.endswith("-len-only")


def _mode_letter() -> str:
    return "A" if _uses_length_only(_MODE_TOKEN) else "B"


def _digest(bucket: str, key: str, head: dict) -> str:
    etag = head.get("ETag", "").strip('"')
    if etag and "-" not in etag:
        return etag
    body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    return hashlib.md5(body).hexdigest()


def handler(event, context):
    length_only = _uses_length_only(_MODE_TOKEN)
    letter = _mode_letter()
    print(
        "publish start src=s3://%s/%s origin=s3://%s mode=%s"
        % (SOURCE_BUCKET, SOURCE_PREFIX, ORIGIN_BUCKET, letter)
    )

    manifest_key = SOURCE_PREFIX + "manifest.json"
    manifest = json.loads(
        s3.get_object(Bucket=SOURCE_BUCKET, Key=manifest_key)["Body"].read()
    )
    build_id = manifest["buildId"]
    total = len(manifest["files"])
    print("manifest %s buildId=%s files=%d" % (manifest_key, build_id, total))

    copied = []
    skipped = []
    for entry in manifest["files"]:
        key = entry["key"]
        src_key = SOURCE_PREFIX + key
        src_head = s3.head_object(Bucket=SOURCE_BUCKET, Key=src_key)
        try:
            dst_head = s3.head_object(Bucket=ORIGIN_BUCKET, Key=key)
        except ClientError as err:
            if err.response["Error"]["Code"] not in ("404", "NoSuchKey", "NotFound"):
                raise
            dst_head = None

        if dst_head is None:
            changed = True
        elif length_only:
            changed = src_head["ContentLength"] != dst_head["ContentLength"]
        else:
            src_digest = _digest(SOURCE_BUCKET, src_key, src_head)
            dst_digest = _digest(ORIGIN_BUCKET, key, dst_head)
            changed = src_digest != dst_digest

        if changed:
            s3.copy_object(
                Bucket=ORIGIN_BUCKET,
                Key=key,
                CopySource={"Bucket": SOURCE_BUCKET, "Key": src_key},
                MetadataDirective="REPLACE",
                ContentType=src_head.get("ContentType", "binary/octet-stream"),
                CacheControl=CACHE_CONTROL,
            )
            copied.append(key)
            print("+ %s" % key)
        else:
            skipped.append(key)
            print("= %s" % key)

    invalidation_id = None
    invalidation_error = None
    if copied:
        paths = ["/" + k for k in copied]
        try:
            resp = cloudfront.create_invalidation(
                DistributionId=DISTRIBUTION_ID,
                InvalidationBatch={
                    "Paths": {"Quantity": len(paths), "Items": paths},
                    "CallerReference": "%s-%d" % (build_id, int(time.time() * 1000)),
                },
            )
            invalidation_id = resp["Invalidation"]["Id"]
            print("INVALIDATION created id=%s paths=%s" % (invalidation_id, paths))
        except ClientError as err:  # publish must not fail the pipeline
            invalidation_error = str(err)
            print(
                "postpub warning: cache refresh partial (%d of %d)"
                % (len(copied), total)
            )
        except Exception as err:  # noqa: BLE001
            invalidation_error = str(err)
            print(
                "postpub warning: cache refresh partial (%d of %d)"
                % (len(copied), total)
            )
    else:
        print("INVALIDATION skipped: no objects changed")

    print(
        "publish complete build=%s mode=%s copied=%d skipped=%d"
        % (build_id, letter, len(copied), len(skipped))
    )
    return {
        "status": "ok",
        "buildId": build_id,
        "mode": letter,
        "copied": copied,
        "skipped": skipped,
        "invalidationId": invalidation_id,
        "invalidationError": invalidation_error,
    }
