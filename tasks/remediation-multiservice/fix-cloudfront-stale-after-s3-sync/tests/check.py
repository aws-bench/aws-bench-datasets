"""Programmatic verification of the stale-CloudFront remediation."""

import hashlib
import json
import os
import time
import urllib.request
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")

ORIGIN_BUCKET = os.environ.get("ORIGIN_BUCKET", "")
BUILD_BUCKET = os.environ.get("BUILD_BUCKET", "")
SOURCE_PREFIX = os.environ.get("SOURCE_PREFIX", "releases/current/")
PUBLISHER_FUNCTION = os.environ.get("PUBLISHER_FUNCTION", "")
PUBLISHER_ROLE = os.environ.get("PUBLISHER_ROLE", "")
CACHE_BASELINE_PARAM = os.environ.get("CACHE_BASELINE_PARAM", "")
MKTG_SYNC_MODE_PARAM = os.environ.get(
    "MKTG_SYNC_MODE_PARAM", "/mktg/publisher/sync-mode"
)

EDGE_PATHS = ["/index.html", "/assets/config.json"]

# Tokens that mean "compare by content length only" — the broken-by-design mode.
LENGTH_ONLY_TOKENS = {"md5-len-only", "len-only", "size"}

session = boto3.Session(region_name=REGION)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _account_id() -> str:
    return session.client("sts").get_caller_identity()["Account"]


_DIST_CACHE: "dict[str, str]" = {}


def _distribution() -> "tuple[str, str]":
    """Resolve (id, edge domain) of the distribution fronting the origin bucket."""
    if not _DIST_CACHE:
        cf = session.client("cloudfront")
        expected = f"{ORIGIN_BUCKET}.s3.{REGION}.amazonaws.com"
        for page in cf.get_paginator("list_distributions").paginate():
            for dist in page.get("DistributionList", {}).get("Items", []) or []:
                for origin in dist.get("Origins", {}).get("Items", []) or []:
                    if origin.get("DomainName") == expected:
                        _DIST_CACHE["id"] = dist["Id"]
                        _DIST_CACHE["domain"] = dist["DomainName"]
        if not _DIST_CACHE:
            raise RuntimeError(f"no distribution found with origin {expected}")
    return _DIST_CACHE["id"], _DIST_CACHE["domain"]


def _distribution_arn() -> str:
    dist_id, _ = _distribution()
    return f"arn:aws:cloudfront::{_account_id()}:distribution/{dist_id}"


def _distribution_config() -> dict:
    cf = session.client("cloudfront")
    return cf.get_distribution(Id=_distribution()[0])["Distribution"][
        "DistributionConfig"
    ]


def _body(bucket: str, key: str) -> bytes:
    s3 = session.client("s3")
    return s3.get_object(Bucket=bucket, Key=key)["Body"].read()


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _manifest() -> dict:
    return json.loads(_body(BUILD_BUCKET, SOURCE_PREFIX + "manifest.json"))


def _http_get(url: str) -> "tuple[int, bytes]":
    req = urllib.request.Request(url, headers={"User-Agent": "internal-canary/1.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.status, resp.read()


def _baseline_epoch() -> float:
    try:
        raw = session.client("ssm").get_parameter(Name=CACHE_BASELINE_PARAM)[
            "Parameter"
        ]["Value"]
        epoch = float(raw)
    except Exception:  # noqa: BLE001
        epoch = 0.0
    if epoch <= 0:
        epoch = time.time() - 4 * 3600
    return epoch


def _post_baseline_invalidations() -> "list[dict]":
    cf = session.client("cloudfront")
    dist_id, _ = _distribution()
    baseline = _baseline_epoch()
    found = []
    marker = None
    while True:
        kwargs = {"DistributionId": dist_id, "MaxItems": "100"}
        if marker:
            kwargs["Marker"] = marker
        page = cf.list_invalidations(**kwargs)["InvalidationList"]
        for item in page.get("Items", []):
            if item["CreateTime"].timestamp() > baseline:
                detail = cf.get_invalidation(DistributionId=dist_id, Id=item["Id"])
                found.append(
                    {
                        "id": item["Id"],
                        "status": detail["Invalidation"]["Status"],
                        "createTime": item["CreateTime"].timestamp(),
                        "paths": detail["Invalidation"]["InvalidationBatch"][
                            "Paths"
                        ].get("Items", []),
                    }
                )
        if not page.get("IsTruncated"):
            return found
        marker = page.get("NextMarker")


def _covers(pattern: str, path: str) -> bool:
    if pattern == path:
        return True
    if pattern.endswith("*") and path.startswith(pattern[:-1]):
        return True
    return False


def _broad_invalidation() -> bool:
    """True iff at least one post-baseline invalidation used a broad (/*) path."""
    for inv in _post_baseline_invalidations():
        for pat in inv.get("paths", []) or []:
            if pat.strip() == "/*":
                return True
    return False


def _origin_shield_disabled() -> bool:
    cfg = _distribution_config()
    for origin in cfg.get("Origins", {}).get("Items", []) or []:
        if origin.get("DomainName") != f"{ORIGIN_BUCKET}.s3.{REGION}.amazonaws.com":
            continue
        shield = origin.get("OriginShield") or {}
        if shield.get("Enabled"):
            return False
    return True


def _shortest_edge_cache_ttl() -> "int | None":
    """Return the shortest CloudFront edge-cache TTL (MinTTL or DefaultTTL)
    across every behavior's CachePolicy on the marketing distribution, or
    None if no CachePolicy is attached. These TTLs are what CloudFront uses
    to decide how long its own edge (and any shield tier) keeps an object."""
    cf = session.client("cloudfront")
    cfg = _distribution_config()
    behaviors = [cfg["DefaultCacheBehavior"]]
    behaviors.extend(cfg.get("CacheBehaviors", {}).get("Items", []) or [])
    ttls = []
    for beh in behaviors:
        pid = beh.get("CachePolicyId")
        if not pid:
            continue
        try:
            policy = cf.get_cache_policy(Id=pid)["CachePolicy"]["CachePolicyConfig"]
        except ClientError:
            continue
        for key in ("MinTTL", "DefaultTTL"):
            value = policy.get(key)
            if value is not None:
                try:
                    ttls.append(int(value))
                except (TypeError, ValueError):
                    pass
    return min(ttls) if ttls else None


def _mktg_sync_mode_token() -> str:
    """The current opaque sync-mode token from SSM (or empty on failure)."""
    try:
        return (
            session.client("ssm")
            .get_parameter(Name=MKTG_SYNC_MODE_PARAM)["Parameter"]["Value"]
            .strip()
        )
    except Exception:  # noqa: BLE001
        return ""


def _simulate(actions: "list[str]", resources: "list[str] | None") -> "dict[str, str]":
    iam = session.client("iam")
    role_arn = iam.get_role(RoleName=PUBLISHER_ROLE)["Role"]["Arn"]
    kwargs = {"PolicySourceArn": role_arn, "ActionNames": actions}
    if resources:
        kwargs["ResourceArns"] = resources
    results = iam.simulate_principal_policy(**kwargs)["EvaluationResults"]
    return {r["EvalActionName"]: r["EvalDecision"] for r in results}


def _role_grants_action(action: str) -> bool:
    """Fallback for environments where policy simulation is unavailable."""
    iam = session.client("iam")
    docs = []
    for name in iam.list_role_policies(RoleName=PUBLISHER_ROLE)["PolicyNames"]:
        docs.append(
            iam.get_role_policy(RoleName=PUBLISHER_ROLE, PolicyName=name)[
                "PolicyDocument"
            ]
        )
    for attached in iam.list_attached_role_policies(RoleName=PUBLISHER_ROLE)[
        "AttachedPolicies"
    ]:
        pol = iam.get_policy(PolicyArn=attached["PolicyArn"])["Policy"]
        docs.append(
            iam.get_policy_version(
                PolicyArn=attached["PolicyArn"], VersionId=pol["DefaultVersionId"]
            )["PolicyVersion"]["Document"]
        )
    service = action.split(":")[0]
    for doc in docs:
        statements = doc.get("Statement", [])
        if isinstance(statements, dict):
            statements = [statements]
        for st in statements:
            if st.get("Effect") != "Allow":
                continue
            acts = st.get("Action", [])
            if isinstance(acts, str):
                acts = [acts]
            for act in acts:
                if act in ("*", f"{service}:*", action):
                    return True
    return False


# ---------------------------------------------------------------------------
# criteria
# ---------------------------------------------------------------------------
@criterion(
    description="Origin bucket holds byte-identical copies of every file in the current build"
)
def origin_matches_current_build(workspace: Path) -> bool:
    try:
        manifest = _manifest()
        for entry in manifest["files"]:
            key = entry["key"]
            src = _body(BUILD_BUCKET, SOURCE_PREFIX + key)
            dst = _body(ORIGIN_BUCKET, key)
            if _sha(src) != _sha(dst):
                print(
                    f"mismatch on {key}: origin sha {_sha(dst)[:12]} != build {_sha(src)[:12]}"
                )
                return False
            if len(dst) != entry["bytes"]:
                print(f"size mismatch on {key}")
                return False
        return True
    except Exception as err:  # noqa: BLE001
        print(f"origin comparison failed: {err}")
        return False


@criterion(
    description="CloudFront serves the current build for the HTML and the runtime config"
)
def cloudfront_serves_current_build(workspace: Path) -> bool:
    try:
        expected = {
            p: _sha(_body(BUILD_BUCKET, SOURCE_PREFIX + p.lstrip("/")))
            for p in EDGE_PATHS
        }
    except Exception as err:  # noqa: BLE001
        print(f"cannot read expected build bytes: {err}")
        return False

    try:
        _, domain = _distribution()
    except Exception as err:  # noqa: BLE001
        print(f"cannot resolve the distribution: {err}")
        return False

    pending = set(EDGE_PATHS)
    deadline = time.time() + 240
    while pending and time.time() < deadline:
        for path in sorted(pending):
            try:
                status, body = _http_get(f"https://{domain}{path}")
            except Exception as err:  # noqa: BLE001
                print(f"GET {path} failed: {err}")
                continue
            if status == 200 and _sha(body) == expected[path]:
                pending.discard(path)
            else:
                print(f"GET {path}: status={status} stale content still cached")
        if pending:
            time.sleep(15)
    if pending:
        print(f"distribution still serving stale content for {sorted(pending)}")
        return False
    return True


@criterion(
    description="Publisher sync-mode configuration is no longer the length-only token"
)
def publisher_sync_mode_is_content_aware(workspace: Path) -> bool:
    """The marketing publisher decides which objects to copy from a token
    stored in SSM (path recorded in the ``MODE_SSM_PATH`` env var). The
    length-only tokens (``md5-len-only``, ``len-only``, ``size``) silently
    skip files whose byte-length was unchanged. Any other non-empty token
    triggers a real content comparison."""
    try:
        cfg = session.client("lambda").get_function_configuration(
            FunctionName=PUBLISHER_FUNCTION
        )
        env = cfg.get("Environment", {}).get("Variables", {})
        if env.get("SOURCE_BUCKET") != BUILD_BUCKET:
            print(f"publisher SOURCE_BUCKET wired to {env.get('SOURCE_BUCKET')!r}")
            return False
        if env.get("ORIGIN_BUCKET") != ORIGIN_BUCKET:
            print(f"publisher ORIGIN_BUCKET wired to {env.get('ORIGIN_BUCKET')!r}")
            return False
        if env.get("DISTRIBUTION_ID") != _distribution()[0]:
            print(
                "publisher DISTRIBUTION_ID no longer points at the marketing distribution"
            )
            return False
        if env.get("SOURCE_PREFIX", SOURCE_PREFIX) != SOURCE_PREFIX:
            return False
        if cfg.get("State", "Active") != "Active":
            return False
        mode_path = env.get("MODE_SSM_PATH", "")
        if not mode_path:
            print("publisher lost its MODE_SSM_PATH wiring")
            return False
        token = _mktg_sync_mode_token().lower()
        if not token:
            print("sync-mode SSM parameter is empty or unreadable")
            return False
        if token in LENGTH_ONLY_TOKENS or token.endswith("-len-only"):
            print(f"publisher still uses length-only sync-mode token {token!r}")
            return False
        return True
    except ClientError as err:
        print(f"lambda/ssm config check failed: {err}")
        return False
    except Exception as err:  # noqa: BLE001
        print(f"lambda/ssm config check failed: {err}")
        return False


@criterion(description="Publisher role can now invalidate the marketing distribution")
def publisher_role_can_invalidate(workspace: Path) -> bool:
    try:
        decisions = _simulate(["cloudfront:CreateInvalidation"], [_distribution_arn()])
        return decisions.get("cloudfront:CreateInvalidation") == "allowed"
    except ClientError as err:
        print(f"simulation unavailable ({err}); falling back to policy inspection")
        try:
            return _role_grants_action("cloudfront:CreateInvalidation")
        except Exception:  # noqa: BLE001
            return False
    except Exception as err:  # noqa: BLE001
        print(f"invalidation permission check failed: {err}")
        return False


@criterion(description="Publisher role was not broadened beyond invalidation rights")
def publisher_role_still_least_privilege(workspace: Path) -> bool:
    try:
        iam = session.client("iam")
        attached = [
            p["PolicyArn"]
            for p in iam.list_attached_role_policies(RoleName=PUBLISHER_ROLE)[
                "AttachedPolicies"
            ]
        ]
        for arn in attached:
            if arn.endswith(
                ("/AdministratorAccess", "/PowerUserAccess", "/CloudFrontFullAccess")
            ):
                print(f"role has over-broad managed policy {arn}")
                return False

        dist_arn = _distribution_arn()
        docs = []
        for name in iam.list_role_policies(RoleName=PUBLISHER_ROLE)["PolicyNames"]:
            docs.append(
                iam.get_role_policy(RoleName=PUBLISHER_ROLE, PolicyName=name)[
                    "PolicyDocument"
                ]
            )
        for att in iam.list_attached_role_policies(RoleName=PUBLISHER_ROLE)[
            "AttachedPolicies"
        ]:
            pol = iam.get_policy(PolicyArn=att["PolicyArn"])["Policy"]
            docs.append(
                iam.get_policy_version(
                    PolicyArn=att["PolicyArn"], VersionId=pol["DefaultVersionId"]
                )["PolicyVersion"]["Document"]
            )

        def _as_list(v):
            if v is None:
                return []
            return v if isinstance(v, list) else [v]

        for doc in docs:
            statements = doc.get("Statement", [])
            if isinstance(statements, dict):
                statements = [statements]
            for st in statements:
                if st.get("Effect") != "Allow":
                    continue
                acts = _as_list(st.get("Action"))
                resources = _as_list(st.get("Resource"))
                grants_invalidation = any(
                    a == "*"
                    or a == "cloudfront:*"
                    or a == "cloudfront:CreateInvalidation"
                    for a in acts
                )
                if not grants_invalidation:
                    continue
                for r in resources:
                    if r == "*" or r.endswith(":distribution/*"):
                        print(
                            "role grants cloudfront:CreateInvalidation on over-broad "
                            f"resource {r!r}"
                        )
                        return False
                if (
                    any(a in ("*", "cloudfront:*") for a in acts)
                    and dist_arn in resources
                ):
                    print(
                        "role grants a wildcard cloudfront action on the distribution ARN"
                    )
                    return False

        dangerous = [
            "cloudfront:DeleteDistribution",
            "cloudfront:UpdateDistribution",
            "iam:AttachRolePolicy",
            "s3:DeleteBucket",
            "cloudfront:CreateDistribution",
        ]
        try:
            decisions = {}
            decisions.update(_simulate(dangerous[:2], [_distribution_arn()]))
            decisions.update(_simulate(dangerous[2:], None))
            for action, decision in decisions.items():
                if decision == "allowed":
                    print(f"role unexpectedly allows {action}")
                    return False
            return True
        except ClientError as err:
            print(f"simulation unavailable ({err}); falling back to policy inspection")
            for action in dangerous:
                if _role_grants_action(action):
                    print(f"policy inspection shows {action} is allowed")
                    return False
            return True
    except Exception as err:  # noqa: BLE001
        print(f"least-privilege check failed: {err}")
        return False


@criterion(
    description="A post-baseline invalidation was issued that covers both edge paths"
)
def invalidation_issued_for_changed_paths(workspace: Path) -> bool:
    try:
        invalidations = _post_baseline_invalidations()
        if not invalidations:
            print("no invalidation created after the cache was warmed")
            return False
        for inv in sorted(invalidations, key=lambda i: i["createTime"], reverse=True):
            patterns = inv["paths"] or []
            if all(any(_covers(pat, edge) for pat in patterns) for edge in EDGE_PATHS):
                return True
        print(f"no post-baseline invalidation covers both {EDGE_PATHS}")
        return False
    except Exception as err:  # noqa: BLE001
        print(f"invalidation check failed: {err}")
        return False


@criterion(
    description=(
        "Layered edge cache (Origin Shield / edge CachePolicy TTLs) is resolved "
        "so it cannot keep serving stale content: either the shield tier is "
        "disabled, the behavior's CachePolicy MinTTL/DefaultTTL is short enough "
        "to expire quickly, or a broad (/*) invalidation was issued to flush "
        "every cache layer."
    )
)
def edge_cache_layering_resolved(workspace: Path) -> bool:
    """The marketing distribution routes through an Origin Shield tier and its
    CachePolicy pins MinTTL/DefaultTTL to one day, so CloudFront's own edge
    (and the shield) hold objects long after the origin changes. A narrow,
    per-path invalidation on the edge alone is not sufficient — an acceptable
    fix must break the layering (shield off), shorten the edge CachePolicy
    TTL (``<= 300``), OR issue a broad invalidation that reaches every
    layer."""
    try:
        shield_off = False
        try:
            shield_off = _origin_shield_disabled()
        except Exception as err:  # noqa: BLE001
            print(f"origin shield check failed: {err}")

        ttl = None
        try:
            ttl = _shortest_edge_cache_ttl()
        except Exception as err:  # noqa: BLE001
            print(f"cache policy inspection failed: {err}")

        broad = False
        try:
            broad = _broad_invalidation()
        except Exception as err:  # noqa: BLE001
            print(f"broad invalidation lookup failed: {err}")

        ttl_ok = ttl is not None and ttl <= 300
        if shield_off or broad or ttl_ok:
            print(
                f"cache-layer resolution: shield_off={shield_off} broad_invalidation={broad} "
                f"ttl={ttl} ttl_ok={ttl_ok}"
            )
            return True
        print(
            "edge cache layering unresolved: shield still on, no broad invalidation, "
            f"and edge CachePolicy TTL={ttl!r} still long"
        )
        return False
    except Exception as err:  # noqa: BLE001
        print(f"cache layering check failed: {err}")
        return False


@criterion(
    description=(
        "Distribution actually serves the current build across the layered "
        "caches: HEAD/GET responses are 200 (no leftover negative-cached 4xx) "
        "and identical to the origin bytes for two consecutive polls."
    )
)
def layered_caches_serve_current_build(workspace: Path) -> bool:
    """A single fresh GET can slip past the shield/edge layers. This check
    requires two consecutive 200s per path, whose body matches the current
    build, before it accepts that the layered caches have converged."""
    try:
        expected = {
            p: _sha(_body(BUILD_BUCKET, SOURCE_PREFIX + p.lstrip("/")))
            for p in EDGE_PATHS
        }
    except Exception as err:  # noqa: BLE001
        print(f"cannot read expected build bytes: {err}")
        return False

    try:
        _, domain = _distribution()
    except Exception as err:  # noqa: BLE001
        print(f"cannot resolve the distribution: {err}")
        return False

    consecutive = {p: 0 for p in EDGE_PATHS}
    deadline = time.time() + 300
    while time.time() < deadline:
        all_ok = True
        for path in EDGE_PATHS:
            try:
                status, body = _http_get(f"https://{domain}{path}")
            except Exception as err:  # noqa: BLE001
                print(f"GET {path} failed: {err}")
                consecutive[path] = 0
                all_ok = False
                continue
            if status == 200 and _sha(body) == expected[path]:
                consecutive[path] += 1
            else:
                consecutive[path] = 0
                all_ok = False
                print(
                    f"GET {path}: status={status} stale/negative-cached content still visible"
                )
        if all_ok and all(v >= 2 for v in consecutive.values()):
            return True
        time.sleep(20)
    print(f"layered caches never converged: consecutive={consecutive}")
    return False


@criterion(
    description="Origin stayed private and the distribution kept its caching contract"
)
def delivery_hardening_intact(workspace: Path) -> bool:
    try:
        s3 = session.client("s3")
        pab = s3.get_public_access_block(Bucket=ORIGIN_BUCKET)[
            "PublicAccessBlockConfiguration"
        ]
        if not all(
            pab.get(k)
            for k in (
                "BlockPublicAcls",
                "IgnorePublicAcls",
                "BlockPublicPolicy",
                "RestrictPublicBuckets",
            )
        ):
            print("origin bucket public access block was weakened")
            return False
        if s3.get_bucket_policy_status(Bucket=ORIGIN_BUCKET)["PolicyStatus"][
            "IsPublic"
        ]:
            print("origin bucket policy is public")
            return False

        cf = session.client("cloudfront")
        dist = cf.get_distribution(Id=_distribution()[0])["Distribution"]
        cfg = dist["DistributionConfig"]
        if not cfg["Enabled"] or cfg.get("DefaultRootObject") != "index.html":
            print("distribution disabled or default root object changed")
            return False

        default_behavior = cfg["DefaultCacheBehavior"]
        origins = {o["Id"]: o for o in cfg["Origins"]["Items"]}
        target = origins.get(default_behavior["TargetOriginId"])
        expected_domain = f"{ORIGIN_BUCKET}.s3.{REGION}.amazonaws.com"
        if not target or target["DomainName"] != expected_domain:
            print(f"default behavior no longer points at {expected_domain}")
            return False

        policy_id = default_behavior.get("CachePolicyId")
        if not policy_id:
            print("default behavior has no cache policy")
            return False
        policy = cf.get_cache_policy(Id=policy_id)["CachePolicy"]["CachePolicyConfig"]
        if policy["MinTTL"] < 86400 or policy.get("DefaultTTL", 0) < 86400:
            print("cache TTLs were slashed instead of invalidating")
            return False
        return True
    except ClientError as err:
        print(f"hardening check failed: {err}")
        return False
    except Exception as err:  # noqa: BLE001
        print(f"hardening check failed: {err}")
        return False
