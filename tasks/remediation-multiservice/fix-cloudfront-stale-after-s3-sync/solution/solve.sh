#!/bin/bash
# Reference solution: repair the marketing publish pipeline, flush every
# cache layer, and republish the current build so the edge serves it.
set -euo pipefail

mkdir -p /logs/agent

python3 - <<'PY'
import hashlib
import json
import os
import time
import urllib.request

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
ORIGIN_BUCKET = os.environ["ORIGIN_BUCKET"]
BUILD_BUCKET = os.environ["BUILD_BUCKET"]
SOURCE_PREFIX = os.environ["SOURCE_PREFIX"]
PUBLISHER_FUNCTION = os.environ["PUBLISHER_FUNCTION"]
PUBLISHER_ROLE = os.environ["PUBLISHER_ROLE"]
MKTG_SYNC_MODE_PARAM = os.environ.get("MKTG_SYNC_MODE_PARAM", "/mktg/publisher/sync-mode")

session = boto3.Session(region_name=REGION)
s3 = session.client("s3")
lam = session.client("lambda")
iam = session.client("iam")
cf = session.client("cloudfront")
ssm = session.client("ssm")
account = session.client("sts").get_caller_identity()["Account"]

# --- resolve the distribution fronting the marketing origin bucket ---
DISTRIBUTION_ID = None
DISTRIBUTION_DOMAIN = None
expected_origin = f"{ORIGIN_BUCKET}.s3.{REGION}.amazonaws.com"
for page in cf.get_paginator("list_distributions").paginate():
    for dist in page.get("DistributionList", {}).get("Items", []) or []:
        for origin in dist.get("Origins", {}).get("Items", []) or []:
            if origin.get("DomainName") == expected_origin:
                DISTRIBUTION_ID = dist["Id"]
                DISTRIBUTION_DOMAIN = dist["DomainName"]
if not DISTRIBUTION_ID:
    raise SystemExit(f"no distribution serves {expected_origin}")
print(f"distribution {DISTRIBUTION_ID} ({DISTRIBUTION_DOMAIN}) serves {ORIGIN_BUCKET}")
dist_arn = f"arn:aws:cloudfront::{account}:distribution/{DISTRIBUTION_ID}"

manifest = json.loads(
    s3.get_object(Bucket=BUILD_BUCKET, Key=SOURCE_PREFIX + "manifest.json")["Body"].read()
)
build_id = manifest["buildId"]
print(f"current build in {BUILD_BUCKET}/{SOURCE_PREFIX} is {build_id}")

# --- 1. Fix the sync-mode token so the publisher compares by content ------
current = ssm.get_parameter(Name=MKTG_SYNC_MODE_PARAM)["Parameter"]["Value"].strip().lower()
print(f"current sync-mode token: {current!r}")
if current in ("md5-len-only", "len-only", "size") or current.endswith("-len-only"):
    ssm.put_parameter(
        Name=MKTG_SYNC_MODE_PARAM, Value="full-body-hash", Type="String", Overwrite=True
    )
    print("sync-mode token now full-body-hash (content comparison)")
    # Force a cold start so the publisher re-reads the SSM value.
    env_cfg = lam.get_function_configuration(FunctionName=PUBLISHER_FUNCTION)
    env = dict(env_cfg.get("Environment", {}).get("Variables", {}))
    # Lambda env keys must match [a-zA-Z]([a-zA-Z0-9_])+, so no leading underscore.
    env["REMEDIATION_MODE_REFRESH"] = str(int(time.time()))
    lam.update_function_configuration(
        FunctionName=PUBLISHER_FUNCTION, Environment={"Variables": env}
    )
    lam.get_waiter("function_updated_v2").wait(
        FunctionName=PUBLISHER_FUNCTION, WaiterConfig={"Delay": 3, "MaxAttempts": 40}
    )

# --- 2. Grant cloudfront:CreateInvalidation on the marketing distribution -
iam.put_role_policy(
    RoleName=PUBLISHER_ROLE,
    PolicyName="mktg-site-publisher-invalidate",
    PolicyDocument=json.dumps(
        {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Sid": "InvalidateMarketingDistribution",
                    "Effect": "Allow",
                    "Action": "cloudfront:CreateInvalidation",
                    "Resource": dist_arn,
                }
            ],
        }
    ),
)
print(f"granted cloudfront:CreateInvalidation on {dist_arn} to {PUBLISHER_ROLE}")

# --- 3. Break the Origin Shield layering by turning it off ----------------
current_cfg = cf.get_distribution_config(Id=DISTRIBUTION_ID)
etag = current_cfg["ETag"]
dist_cfg = current_cfg["DistributionConfig"]
mutated = False
for origin in dist_cfg.get("Origins", {}).get("Items", []) or []:
    if origin.get("DomainName") == expected_origin:
        shield = origin.get("OriginShield") or {}
        if shield.get("Enabled"):
            origin["OriginShield"] = {"Enabled": False}
            mutated = True
if mutated:
    cf.update_distribution(Id=DISTRIBUTION_ID, IfMatch=etag, DistributionConfig=dist_cfg)
    print("Origin Shield disabled for the marketing origin")

# --- 4. Re-run the publisher and pick up its invalidation -----------------
deadline = time.time() + 120
while time.time() < deadline:
    try:
        res = iam.simulate_principal_policy(
            PolicySourceArn=iam.get_role(RoleName=PUBLISHER_ROLE)["Role"]["Arn"],
            ActionNames=["cloudfront:CreateInvalidation"],
            ResourceArns=[dist_arn],
        )["EvaluationResults"]
        if res and res[0]["EvalDecision"] == "allowed":
            print("permission is live")
            break
    except ClientError as err:
        print(f"simulation retry: {err}")
    time.sleep(10)

invalidation_id = None
for attempt in range(1, 6):
    payload = json.loads(
        lam.invoke(
            FunctionName=PUBLISHER_FUNCTION,
            InvocationType="RequestResponse",
            Payload=json.dumps({"source": "remediation", "attempt": attempt}).encode(),
        )["Payload"].read()
    )
    print(f"publish attempt {attempt}: {json.dumps(payload)}")
    if payload.get("invalidationId"):
        invalidation_id = payload["invalidationId"]
        break
    if payload.get("invalidationError"):
        time.sleep(15)
        continue
    break

# --- 5. Broad invalidation to flush every remaining cache layer -----------
broad_id = cf.create_invalidation(
    DistributionId=DISTRIBUTION_ID,
    InvalidationBatch={
        "Paths": {"Quantity": 1, "Items": ["/*"]},
        "CallerReference": f"remediation-broad-{int(time.time() * 1000)}",
    },
)["Invalidation"]["Id"]
print(f"created broad invalidation {broad_id} for /*")
cf.get_waiter("invalidation_completed").wait(
    DistributionId=DISTRIBUTION_ID,
    Id=broad_id,
    WaiterConfig={"Delay": 10, "MaxAttempts": 60},
)
invalidation_id = invalidation_id or broad_id
print(f"invalidations complete (narrow={invalidation_id}, broad={broad_id})")

# --- 6. Verify the edge serves the current build --------------------------
def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def http_get(path: str):
    req = urllib.request.Request(
        f"https://{DISTRIBUTION_DOMAIN}{path}", headers={"User-Agent": "remediation/1.0"}
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.status, resp.read()

pending = {"/index.html", "/assets/config.json"}
expected = {
    p: sha(s3.get_object(Bucket=BUILD_BUCKET, Key=SOURCE_PREFIX + p.lstrip("/"))["Body"].read())
    for p in pending
}
deadline = time.time() + 300
while pending and time.time() < deadline:
    for path in sorted(pending):
        try:
            status, body = http_get(path)
        except Exception as err:  # noqa: BLE001
            print(f"GET {path}: {err}")
            continue
        print(f"GET {path}: {status} fresh={sha(body) == expected[path]}")
        if status == 200 and sha(body) == expected[path]:
            pending.discard(path)
    if pending:
        time.sleep(15)
if pending:
    raise SystemExit(f"edge still stale for {sorted(pending)}")

with open("/logs/agent/agent-output.json", "w") as fh:
    json.dump(
        {
            "origin_bucket": ORIGIN_BUCKET,
            "invalidation_id": invalidation_id,
            "broad_invalidation_id": broad_id,
            "published_build_id": build_id,
        },
        fh,
        indent=2,
    )

with open("/logs/agent/agent-output.txt", "w") as fh:
    fh.write(
        "The marketing publisher was configured with an opaque length-only sync-mode\n"
        "token in SSM, so it decided what to copy from the build bucket by byte length\n"
        "alone. Objects whose content changed without changing size were silently\n"
        "skipped, leaving a half-published site in the origin bucket. The publisher\n"
        "then tried to invalidate the distribution and failed because its execution\n"
        "role had no cloudfront:CreateInvalidation permission, yet the handler\n"
        "swallowed the error and returned success. The distribution also routed\n"
        "requests through an Origin Shield tier and applied a Cache-Control override\n"
        "with a long s-maxage, so a narrow per-path invalidation would not have\n"
        "reached every cache layer.\n\n"
        "Fix: switched the sync-mode SSM parameter to full-body-hash, granted the\n"
        f"role cloudfront:CreateInvalidation scoped to {dist_arn}, disabled Origin\n"
        "Shield on the marketing origin, re-ran the publish so the origin bucket\n"
        f"matches build {build_id}, and issued a broad /* invalidation which was\n"
        "waited on until the edge served the current build.\n"
    )
print("remediation complete")
PY
