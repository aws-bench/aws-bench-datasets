"""Pre-invoke: rebuild the trial-fresh starting state for the stale-site task.

Every trial starts from the same observable state:

1. the marketing publisher role + function config are restored to the captured
   baseline (size-only comparison, no cloudfront:CreateInvalidation),
2. both origin buckets are reset to their previously published release,
3. both builds are re-published through the real S3-notification pipelines, so
   CloudWatch holds a fresh marketing run showing the skipped same-size objects
   and the AccessDenied on the invalidation call, next to a fresh docs run that
   copied its same-size changes and invalidated successfully,
4. the marketing distribution cache is flushed and re-warmed with the objects
   currently in the origin bucket, so the site demonstrably serves the old build
   from cache,
5. the epoch at which warming finished is recorded.
"""

import hashlib
import json
import os
import time
import urllib.request
from pathlib import Path
from typing import Optional

import boto3

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
STACK_NAME = "remediation-multiservice-WebPlatform-uobyzx8z7-us-east-1"
PREV_RELEASE_PREFIX = "releases/2024.11.02-a41c9d/"
PW_ALPHA_PREV_RELEASE_PREFIX = "pw-alpha-releases/2025.06.02-pwa003/"
PW_ALPHA_SOURCE_PREFIX = "pw-alpha-releases/current/"
MKTG_SYNC_MODE_INITIAL = "md5-len-only"
WARM_PATHS = ["/index.html", "/assets/config.json"]
PLACEHOLDER_OUTPUT = Path("/logs/pre_invoke/placeholder.json")


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def stack_outputs(session: boto3.Session, region: str) -> "dict[str, str]":
    cfn = session.client("cloudformation", region_name=region)
    stack = cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]
    return {o["OutputKey"]: o["OutputValue"] for o in stack.get("Outputs", [])}


def resolve_distribution(session: boto3.Session, origin_bucket: str, region: str):
    """Find the distribution whose origin is ``origin_bucket`` (id, edge domain)."""
    cf = session.client("cloudfront")
    expected = f"{origin_bucket}.s3.{region}.amazonaws.com"
    paginator = cf.get_paginator("list_distributions")
    for page in paginator.paginate():
        for dist in page.get("DistributionList", {}).get("Items", []) or []:
            for origin in dist.get("Origins", {}).get("Items", []) or []:
                if origin.get("DomainName") == expected:
                    return dist["Id"], dist["DomainName"]
    raise RuntimeError(f"no distribution found with origin {expected}")


def list_keys(s3, bucket: str, prefix: str = "") -> "list[str]":
    keys, token = [], None
    while True:
        kwargs = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        page = s3.list_objects_v2(**kwargs)
        keys.extend(o["Key"] for o in page.get("Contents", []))
        if not page.get("IsTruncated"):
            return keys
        token = page.get("NextContinuationToken")


def load_baseline(
    session: boto3.Session, region: str, outputs: "dict[str, str]"
) -> dict:
    ssm = session.client("ssm", region_name=region)
    raw = ssm.get_parameter(Name=outputs["RoleBaselineParameterName"])["Parameter"][
        "Value"
    ]
    baseline = json.loads(raw)
    if not baseline.get("inlinePolicies"):
        raise RuntimeError(
            "publisher baseline snapshot is empty - scenario setup did not run"
        )
    return baseline


def restore_publisher_baseline(
    session: boto3.Session, region: str, baseline: dict
) -> None:
    """Undo any permission/config change made to the marketing publisher."""
    iam = session.client("iam")
    lam = session.client("lambda", region_name=region)
    role_name = baseline["roleName"]
    fn_name = baseline["functionName"]

    wanted_inline = baseline["inlinePolicies"]
    for name in iam.list_role_policies(RoleName=role_name)["PolicyNames"]:
        if name not in wanted_inline:
            iam.delete_role_policy(RoleName=role_name, PolicyName=name)
            print(f"removed inline policy {name} from {role_name}")
    for name, doc in wanted_inline.items():
        iam.put_role_policy(
            RoleName=role_name, PolicyName=name, PolicyDocument=json.dumps(doc)
        )

    wanted_attached = set(baseline["attachedPolicies"])
    current_attached = {
        p["PolicyArn"]
        for p in iam.list_attached_role_policies(RoleName=role_name)["AttachedPolicies"]
    }
    for arn in current_attached - wanted_attached:
        iam.detach_role_policy(RoleName=role_name, PolicyArn=arn)
        print(f"detached {arn} from {role_name}")
    for arn in wanted_attached - current_attached:
        iam.attach_role_policy(RoleName=role_name, PolicyArn=arn)

    current_env = (
        lam.get_function_configuration(FunctionName=fn_name)
        .get("Environment", {})
        .get("Variables", {})
    )
    if current_env != baseline["environment"]:
        lam.update_function_configuration(
            FunctionName=fn_name, Environment={"Variables": baseline["environment"]}
        )
        lam.get_waiter("function_updated_v2").wait(
            FunctionName=fn_name, WaiterConfig={"Delay": 3, "MaxAttempts": 40}
        )
        print(f"restored environment of {fn_name}")


def reset_origin(
    session: boto3.Session,
    region: str,
    origin_bucket: str,
    build_bucket: str,
    release_prefix: str,
) -> None:
    """Make an origin bucket look like its last successful publish again."""
    s3 = session.client("s3", region_name=region)

    existing = list_keys(s3, origin_bucket)
    if existing:
        s3.delete_objects(
            Bucket=origin_bucket, Delete={"Objects": [{"Key": k} for k in existing]}
        )

    keys = list_keys(s3, build_bucket, release_prefix)
    if not keys:
        raise RuntimeError(
            f"release missing under s3://{build_bucket}/{release_prefix}"
        )

    copied = 0
    for src_key in keys:
        rel = src_key[len(release_prefix) :]
        if rel == "manifest.json":
            continue  # build metadata, not site content
        s3.copy_object(
            Bucket=origin_bucket,
            Key=rel,
            CopySource={"Bucket": build_bucket, "Key": src_key},
            MetadataDirective="COPY",
        )
        copied += 1
    print(f"origin s3://{origin_bucket} reset from {release_prefix} ({copied} objects)")


def trigger_publish(
    session: boto3.Session, region: str, build_bucket: str, source_prefix: str
) -> float:
    """Re-put a release manifest, which fires its publisher via S3 events."""
    s3 = session.client("s3", region_name=region)
    manifest_key = source_prefix + "manifest.json"
    body = s3.get_object(Bucket=build_bucket, Key=manifest_key)["Body"].read()
    started = time.time() - 5
    s3.put_object(
        Bucket=build_bucket, Key=manifest_key, Body=body, ContentType="application/json"
    )
    print(f"re-published s3://{build_bucket}/{manifest_key}")
    return started


def wait_for_log_patterns(
    session: boto3.Session,
    region: str,
    log_group: str,
    started: float,
    patterns: "dict[str, str]",
    fallback_function: Optional[str] = None,
    budget: int = 300,
) -> None:
    logs = session.client("logs", region_name=region)
    lam = session.client("lambda", region_name=region)

    deadline = time.time() + budget
    invoked_directly = False
    while time.time() < deadline:
        found = {}
        for label, pattern in patterns.items():
            events = logs.filter_log_events(
                logGroupName=log_group,
                startTime=int(started * 1000),
                filterPattern=pattern,
                limit=5,
            ).get("events", [])
            if events:
                found[label] = events[-1]["message"].strip()
        if len(found) == len(patterns):
            for label in patterns:
                print(f"evidence[{log_group}][{label}]: {found[label]}")
            return
        if fallback_function and not invoked_directly and time.time() - started > 120:
            print(f"S3 notification slow; invoking {fallback_function} directly")
            lam.invoke(
                FunctionName=fallback_function,
                InvocationType="RequestResponse",
                Payload=json.dumps({"source": "trial-setup"}).encode(),
            )
            invoked_directly = True
        time.sleep(10)
    raise RuntimeError(f"expected evidence {sorted(patterns)} not found in {log_group}")


def flush_cache(session: boto3.Session, distribution_id: str) -> None:
    cf = session.client("cloudfront")
    resp = cf.create_invalidation(
        DistributionId=distribution_id,
        InvalidationBatch={
            "Paths": {"Quantity": 1, "Items": ["/*"]},
            "CallerReference": f"trial-reset-{int(time.time() * 1000)}",
        },
    )
    inv_id = resp["Invalidation"]["Id"]
    cf.get_waiter("invalidation_completed").wait(
        DistributionId=distribution_id,
        Id=inv_id,
        WaiterConfig={"Delay": 10, "MaxAttempts": 45},
    )
    print(f"flushed distribution {distribution_id} cache (invalidation {inv_id})")


def _fetch(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "trial-setup/1.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.status, resp.read(), {k.lower(): v for k, v in resp.headers.items()}


def warm_cache(
    session: boto3.Session, region: str, outputs: "dict[str, str]", domain: str
) -> None:
    """Prime every edge path the trial inspects with the bytes now in the origin."""
    s3 = session.client("s3", region_name=region)
    origin = outputs["OriginBucketName"]

    expected = {}
    for path in WARM_PATHS:
        body = s3.get_object(Bucket=origin, Key=path.lstrip("/"))["Body"].read()
        expected[path] = hashlib.sha256(body).hexdigest()

    deadline = time.time() + 300
    pending = set(WARM_PATHS)
    while pending and time.time() < deadline:
        for path in sorted(pending):
            try:
                status, body, headers = _fetch(f"https://{domain}{path}")
            except Exception as err:  # noqa: BLE001 - distribution may still be settling
                print(f"warm {path}: {type(err).__name__}: {err}")
                continue
            digest = hashlib.sha256(body).hexdigest()
            xcache = headers.get("x-cache", "")
            print(
                f"warm {path}: {status} x-cache={xcache} match={digest == expected[path]}"
            )
            if (
                status == 200
                and digest == expected[path]
                and "Hit from cloudfront" in xcache
            ):
                pending.discard(path)
        if pending:
            time.sleep(15)
    if pending:
        raise RuntimeError(
            f"cache never served the expected bytes for {sorted(pending)}"
        )


def record_cache_baseline(
    session: boto3.Session, region: str, outputs: "dict[str, str]"
) -> int:
    ssm = session.client("ssm", region_name=region)
    epoch = int(time.time())
    ssm.put_parameter(
        Name=outputs["CacheBaselineParameterName"],
        Value=str(epoch),
        Type="String",
        Overwrite=True,
    )
    print(f"recorded cache baseline epoch {epoch}")
    return epoch


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------
def run(session: Optional[boto3.Session] = None, region: str = REGION, **kwargs):
    if session is None:
        session = boto3.Session(region_name=region)

    outputs = stack_outputs(session, region)
    baseline = load_baseline(session, region, outputs)
    build_bucket = outputs["BuildArtifactsBucketName"]

    restore_publisher_baseline(session, region, baseline)

    # --- healthy reference pipeline: pw-alpha --------------------------
    reset_origin(
        session,
        region,
        outputs["PwAlphaOriginBucketName"],
        build_bucket,
        PW_ALPHA_PREV_RELEASE_PREFIX,
    )
    pw_alpha_started = trigger_publish(
        session, region, build_bucket, PW_ALPHA_SOURCE_PREFIX
    )

    # --- the pipeline under investigation: marketing --------------------
    reset_origin(
        session, region, outputs["OriginBucketName"], build_bucket, PREV_RELEASE_PREFIX
    )

    # Re-seed the marketing publisher sync-mode SSM parameter so the broken
    # "md5+length-only" comparator is in effect for every trial.
    mktg_sync_param = outputs.get("MktgSyncModeParameterName")
    if mktg_sync_param:
        ssm = session.client("ssm", region_name=region)
        ssm.put_parameter(
            Name=mktg_sync_param,
            Value=MKTG_SYNC_MODE_INITIAL,
            Type="String",
            Overwrite=True,
        )
        print(f"reset {mktg_sync_param} to {MKTG_SYNC_MODE_INITIAL}")

    mktg_started = trigger_publish(
        session, region, build_bucket, outputs["SourcePrefix"]
    )

    wait_for_log_patterns(
        session,
        region,
        outputs["PublisherLogGroupName"],
        mktg_started,
        {
            "complete": '"publish complete"',
            "skipped_html": '"= index.html"',
            "invalidation_denied": '"cache refresh partial"',
        },
        fallback_function=outputs["PublisherFunctionName"],
        budget=300,
    )
    wait_for_log_patterns(
        session,
        region,
        f"/aws/lambda/{outputs['PwAlphaPublisherFunctionName']}",
        pw_alpha_started,
        {
            "complete": '"publish complete"',
            "invalidated": '"INVALIDATION created"',
        },
        fallback_function=outputs["PwAlphaPublisherFunctionName"],
        budget=300,
    )

    dist_id, dist_domain = resolve_distribution(
        session, outputs["OriginBucketName"], region
    )
    print(f"marketing distribution {dist_id} ({dist_domain})")
    flush_cache(session, dist_id)
    warm_cache(session, region, outputs, dist_domain)
    record_cache_baseline(session, region, outputs)

    PLACEHOLDER_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    PLACEHOLDER_OUTPUT.write_text(json.dumps({}))
    print("pre-invoke complete")


if __name__ == "__main__":
    run()
