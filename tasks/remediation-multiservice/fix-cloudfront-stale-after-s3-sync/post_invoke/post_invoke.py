"""Post-invoke: return the baseline resources to their broken-by-design state.

Reverses everything the agent may have changed on resources this scenario owns:
the marketing publisher's execution-role policies, its environment
configuration, and the contents of the CloudFront origin bucket. Net-new
resources created by the agent are swept by the framework.

Best effort: never raises, safe to run repeatedly.
"""

import json
import os
import time
from typing import Optional

import boto3

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
STACK_NAME = "remediation-multiservice-WebPlatform-uobyzx8z7-us-east-1"
PREV_RELEASE_PREFIX = "releases/2024.11.02-a41c9d/"

# CDK baselines for resources the setup snapshot does not cover. Must match
# web_platform_stack.ts; that baseline is broken by design.
MKTG_ORIGIN_SHIELD_ENABLED = True
MKTG_ORIGIN_SHIELD_REGION = "us-east-1"
MKTG_EDGE_HEADERS_POLICY_PREFIX = "mktg-site-edge-headers-"
MKTG_EDGE_CACHE_CONTROL = "max-age=60, s-maxage=86400"
PW_ALPHA_SYNC_MODE_PARAM = "/pw-alpha/publisher/sync-mode"
PW_ALPHA_SYNC_MODE_VALUE = "full-body-hash"
# The CacheBaselineParam value the WebPlatform template declares.
CACHE_BASELINE_EPOCH_VALUE = "0"


def stack_outputs(session: boto3.Session, region: str) -> "dict[str, str]":
    cfn = session.client("cloudformation", region_name=region)
    stack = cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]
    return {o["OutputKey"]: o["OutputValue"] for o in stack.get("Outputs", [])}


def restore_publisher_baseline(
    session: boto3.Session, region: str, baseline: dict
) -> None:
    iam = session.client("iam")
    lam = session.client("lambda", region_name=region)
    ssm = session.client("ssm", region_name=region)
    role_name = baseline["roleName"]
    fn_name = baseline["functionName"]

    sync_param = baseline.get("syncModeParameter")
    sync_value = baseline.get("syncModeValue")
    if sync_param and sync_value:
        try:
            ssm.put_parameter(
                Name=sync_param, Value=sync_value, Type="String", Overwrite=True
            )
            print(f"restored sync-mode parameter {sync_param}")
        except Exception as err:  # noqa: BLE001
            print(f"post-invoke: sync-mode restore failed: {err}")

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
    current = {
        p["PolicyArn"]
        for p in iam.list_attached_role_policies(RoleName=role_name)["AttachedPolicies"]
    }
    for arn in current - wanted_attached:
        iam.detach_role_policy(RoleName=role_name, PolicyArn=arn)
        print(f"detached {arn} from {role_name}")
    for arn in wanted_attached - current:
        iam.attach_role_policy(RoleName=role_name, PolicyArn=arn)

    env = (
        lam.get_function_configuration(FunctionName=fn_name)
        .get("Environment", {})
        .get("Variables", {})
    )
    if env != baseline["environment"]:
        lam.update_function_configuration(
            FunctionName=fn_name, Environment={"Variables": baseline["environment"]}
        )
        lam.get_waiter("function_updated_v2").wait(
            FunctionName=fn_name, WaiterConfig={"Delay": 3, "MaxAttempts": 40}
        )
        print(f"restored environment of {fn_name}")


def restore_mktg_origin_shield(
    session: boto3.Session, origin_bucket: str, region: str
) -> None:
    """Ensure the marketing distribution's S3 origin has Origin Shield on.

    CDK deploys the marketing origin with ``originShieldEnabled=true`` in
    ``us-east-1``.
    """
    cf = session.client("cloudfront")
    expected_domain = f"{origin_bucket}.s3.{region}.amazonaws.com"

    dist_id = None
    paginator = cf.get_paginator("list_distributions")
    for page in paginator.paginate():
        for dist in page.get("DistributionList", {}).get("Items", []) or []:
            for origin in dist.get("Origins", {}).get("Items", []) or []:
                if origin.get("DomainName") == expected_domain:
                    dist_id = dist["Id"]
                    break
            if dist_id:
                break
        if dist_id:
            break
    if not dist_id:
        print(f"post-invoke: no distribution found for origin {expected_domain}")
        return

    resp = cf.get_distribution_config(Id=dist_id)
    config = resp["DistributionConfig"]
    etag = resp["ETag"]

    changed = False
    for origin in config.get("Origins", {}).get("Items", []) or []:
        if origin.get("DomainName") != expected_domain:
            continue
        shield = origin.get("OriginShield") or {}
        want_enabled = MKTG_ORIGIN_SHIELD_ENABLED
        want_region = MKTG_ORIGIN_SHIELD_REGION
        current_enabled = bool(shield.get("Enabled"))
        current_region = shield.get("OriginShieldRegion")
        if current_enabled != want_enabled or (
            want_enabled and current_region != want_region
        ):
            origin["OriginShield"] = {
                "Enabled": want_enabled,
                "OriginShieldRegion": want_region,
            }
            changed = True

    if not changed:
        return

    try:
        cf.update_distribution(Id=dist_id, IfMatch=etag, DistributionConfig=config)
        print(f"restored Origin Shield on distribution {dist_id}")
    except Exception as err:  # noqa: BLE001
        print(f"post-invoke: Origin Shield restore failed: {err}")


def restore_mktg_edge_headers(session: boto3.Session) -> None:
    """Restore the marketing edge headers policy's Cache-Control directive.

    CDK sets ``Cache-Control: max-age=60, s-maxage=86400`` on the
    ``mktg-site-edge-headers-<sfx>`` response headers policy so CloudFront
    holds objects for a day while viewers cache for a minute.
    """
    cf = session.client("cloudfront")

    # ListResponseHeadersPolicies has no botocore paginator, so walk NextMarker by
    # hand; get_paginator raises OperationNotPageableError before any policy is read.
    target_id = None
    marker = None
    while target_id is None:
        kwargs = {"Type": "Custom"}
        if marker:
            kwargs["Marker"] = marker
        listing = cf.list_response_headers_policies(**kwargs)[
            "ResponseHeadersPolicyList"
        ]
        for entry in listing.get("Items", []) or []:
            summary = entry.get("ResponseHeadersPolicy", {})
            config = summary.get("ResponseHeadersPolicyConfig", {})
            name = config.get("Name", "")
            if name.startswith(MKTG_EDGE_HEADERS_POLICY_PREFIX):
                target_id = summary.get("Id")
                break
        marker = listing.get("NextMarker")
        if not marker:
            break
    if not target_id:
        print(
            "post-invoke: marketing edge headers policy "
            f"(name prefix {MKTG_EDGE_HEADERS_POLICY_PREFIX!r}) not found"
        )
        return

    detail = cf.get_response_headers_policy_config(Id=target_id)
    config = detail["ResponseHeadersPolicyConfig"]
    etag = detail["ETag"]

    custom = config.setdefault("CustomHeadersConfig", {"Quantity": 0, "Items": []})
    items = custom.get("Items") or []
    changed = False
    found = False
    for header in items:
        if header.get("Header", "").lower() == "cache-control":
            found = True
            if header.get("Value") != MKTG_EDGE_CACHE_CONTROL or not header.get(
                "Override", False
            ):
                header["Value"] = MKTG_EDGE_CACHE_CONTROL
                header["Override"] = True
                changed = True
            break
    if not found:
        items.append(
            {
                "Header": "Cache-Control",
                "Value": MKTG_EDGE_CACHE_CONTROL,
                "Override": True,
            }
        )
        changed = True
    custom["Items"] = items
    custom["Quantity"] = len(items)

    if not changed:
        return

    try:
        cf.update_response_headers_policy(
            Id=target_id,
            IfMatch=etag,
            ResponseHeadersPolicyConfig=config,
        )
        print(f"restored Cache-Control on response headers policy {target_id}")
    except Exception as err:  # noqa: BLE001
        print(f"post-invoke: edge headers restore failed: {err}")


def wait_for_distributions_deployed(
    session: boto3.Session, timeout_sec: float = 600.0
) -> None:
    """Block until no distribution is still redeploying.

    ``update_distribution`` and ``update_response_headers_policy`` are applied
    asynchronously: the call returns while CloudFront propagates the change and
    the distribution sits at ``Status=InProgress`` for minutes. Until it reads
    ``Deployed``, the account still describes the pre-restore configuration, so
    returning here early leaves the restored values invisible to anything that
    inspects the distribution next.
    """
    cf = session.client("cloudfront")
    deadline = time.time() + timeout_sec
    while True:
        pending = []
        for page in cf.get_paginator("list_distributions").paginate():
            for dist in page.get("DistributionList", {}).get("Items", []) or []:
                if dist.get("Status") != "Deployed":
                    pending.append(dist["Id"])
        if not pending:
            return
        if time.time() >= deadline:
            print(
                f"post-invoke: {len(pending)} distribution(s) still redeploying after "
                f"{timeout_sec:.0f}s: {pending}"
            )
            return
        print(
            f"post-invoke: waiting for {len(pending)} distribution(s) to redeploy: {pending}"
        )
        time.sleep(15)


def restore_pw_alpha_sync_mode(session: boto3.Session, region: str) -> None:
    """Reset the pw-alpha sibling's sync-mode to the CDK baseline ``full-body-hash``."""
    ssm = session.client("ssm", region_name=region)
    try:
        ssm.put_parameter(
            Name=PW_ALPHA_SYNC_MODE_PARAM,
            Value=PW_ALPHA_SYNC_MODE_VALUE,
            Type="String",
            Overwrite=True,
        )
        print(f"reset {PW_ALPHA_SYNC_MODE_PARAM} to {PW_ALPHA_SYNC_MODE_VALUE}")
    except Exception as err:  # noqa: BLE001
        print(f"post-invoke: pw-alpha sync-mode restore failed: {err}")


def restore_cache_baseline_epoch(
    session: boto3.Session, region: str, outputs: "dict[str, str]"
) -> None:
    """Put the cache-warm epoch parameter back to the template's ``0``."""
    ssm = session.client("ssm", region_name=region)
    name = outputs["CacheBaselineParameterName"]
    try:
        ssm.put_parameter(
            Name=name,
            Value=CACHE_BASELINE_EPOCH_VALUE,
            Type="String",
            Overwrite=True,
        )
        print(f"reset {name} to {CACHE_BASELINE_EPOCH_VALUE}")
    except Exception as err:  # noqa: BLE001
        print(f"post-invoke: cache baseline restore failed: {err}")


def reset_origin_to_previous_release(
    session: boto3.Session, region: str, outputs: "dict[str, str]"
) -> None:
    s3 = session.client("s3", region_name=region)
    origin = outputs["OriginBucketName"]
    build_bucket = outputs["BuildArtifactsBucketName"]

    def list_keys(bucket: str, prefix: str = "") -> "list[str]":
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

    existing = list_keys(origin)
    if existing:
        s3.delete_objects(
            Bucket=origin, Delete={"Objects": [{"Key": k} for k in existing]}
        )

    for src_key in list_keys(build_bucket, PREV_RELEASE_PREFIX):
        rel = src_key[len(PREV_RELEASE_PREFIX) :]
        if rel == "manifest.json":
            continue
        s3.copy_object(
            Bucket=origin,
            Key=rel,
            CopySource={"Bucket": build_bucket, "Key": src_key},
            MetadataDirective="COPY",
        )
    print(f"origin s3://{origin} reset to {PREV_RELEASE_PREFIX}")


def run(session: Optional[boto3.Session] = None, region: str = REGION, **kwargs):
    if session is None:
        session = boto3.Session(region_name=region)

    try:
        outputs = stack_outputs(session, region)
    except Exception as err:  # noqa: BLE001
        print(f"post-invoke: cannot read stack outputs ({err}); nothing to reset")
        return

    try:
        ssm = session.client("ssm", region_name=region)
        raw = ssm.get_parameter(Name=outputs["RoleBaselineParameterName"])["Parameter"][
            "Value"
        ]
        baseline = json.loads(raw)
        if baseline.get("inlinePolicies"):
            restore_publisher_baseline(session, region, baseline)
        else:
            print("post-invoke: baseline snapshot empty, skipping IAM/config restore")
    except Exception as err:  # noqa: BLE001
        print(f"post-invoke: publisher restore failed: {err}")

    try:
        reset_origin_to_previous_release(session, region, outputs)
    except Exception as err:  # noqa: BLE001
        print(f"post-invoke: origin reset failed: {err}")

    try:
        restore_mktg_origin_shield(session, outputs["OriginBucketName"], region)
    except Exception as err:  # noqa: BLE001
        print(f"post-invoke: Origin Shield restore failed: {err}")

    try:
        restore_mktg_edge_headers(session)
    except Exception as err:  # noqa: BLE001
        print(f"post-invoke: edge headers restore failed: {err}")

    try:
        restore_pw_alpha_sync_mode(session, region)
    except Exception as err:  # noqa: BLE001
        print(f"post-invoke: pw-alpha sync-mode restore failed: {err}")

    try:
        restore_cache_baseline_epoch(session, region, outputs)
    except Exception as err:  # noqa: BLE001
        print(f"post-invoke: cache baseline restore failed: {err}")

    # Settle before returning; both restores above are asynchronous.
    try:
        wait_for_distributions_deployed(session)
    except Exception as err:  # noqa: BLE001
        print(f"post-invoke: distribution settle wait failed: {err}")

    print("post-invoke complete")


if __name__ == "__main__":
    run()
