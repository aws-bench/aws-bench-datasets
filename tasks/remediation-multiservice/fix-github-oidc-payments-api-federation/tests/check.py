"""Verification for the payments-api GitHub OIDC federation fix.

The deploy role's trust policy is evaluated the way STS evaluates it: the live
AssumeRolePolicyDocument is fetched with iam:GetRole and simulated against the exact
id_token claim sets that GitHub presents for each repository in this organisation.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")

DEPLOY_ROLE_NAME = os.environ.get("DEPLOY_ROLE_NAME", "acme-ci-github-deploy-role")
DEPLOY_POLICY_NAME = os.environ.get("DEPLOY_POLICY_NAME", "acme-ci-deploy-permissions")
STAGING_ROLE_NAME = os.environ.get(
    "STAGING_ROLE_NAME", "acme-ci-github-deploy-role-staging"
)
AUDIT_ROLE_NAME = os.environ.get(
    "AUDIT_ROLE_NAME", "acme-ci-github-audit-readonly-role"
)
ORCHESTRATOR_FUNCTION_NAME = os.environ.get(
    "ORCHESTRATOR_FUNCTION_NAME", "acme-deploy-orchestrator"
)
OIDC_PROVIDER_ARN = os.environ.get("OIDC_PROVIDER_ARN", "")

OIDC_HOST = "token.actions.githubusercontent.com"
CLAIM_PREFIX = f"{OIDC_HOST}:"

session = boto3.Session(region_name=REGION)

# ---------------------------------------------------------------------------
# id_token claim sets presented by the acme-corp organisation (fixed by the
# environment: the same values are in the captured tokens in SSM and in the
# archived GitHub Actions job logs).
# ---------------------------------------------------------------------------

PAYMENTS_API_CLAIMS = {
    "sub": "repo:acme-corp@1042/payments-api@88317:ref:refs/heads/main",
    "aud": OIDC_HOST,
    "iss": f"https://{OIDC_HOST}",
    "repository": "acme-corp@1042/payments-api@88317",
    "repository_owner": "acme-corp@1042",
    "repository_id": "88317",
    "repository_owner_id": "1042",
    "repository_visibility": "private",
    "ref": "refs/heads/main",
    "ref_type": "branch",
    "ref_protected": "true",
    "sha": "9a1f6c04c0f1b1b5f6d3d9d70a4b3e8f2c7d5a11",
    "actor": "ci-bot-acme",
    "actor_id": "77219",
    "event_name": "push",
    "environment": "production",
    "workflow": "deploy-production",
    "workflow_ref": "acme-corp@1042/payments-api@88317/.github/workflows/deploy.yml@refs/heads/main",
    "workflow_sha": "9a1f6c04c0f1b1b5f6d3d9d70a4b3e8f2c7d5a11",
    "job_workflow_ref": "acme-corp@1042/payments-api@88317/.github/workflows/deploy.yml@refs/heads/main",
    "job_workflow_sha": "9a1f6c04c0f1b1b5f6d3d9d70a4b3e8f2c7d5a11",
    "runner_environment": "self-hosted",
}

LEGACY_SERVICE_CLAIMS = {
    "sub": "repo:acme-corp/legacy-service:ref:refs/heads/main",
    "aud": OIDC_HOST,
    "iss": f"https://{OIDC_HOST}",
    "repository": "acme-corp/legacy-service",
    "repository_owner": "acme-corp",
    "repository_id": "41207",
    "repository_owner_id": "1042",
    "repository_visibility": "private",
    "ref": "refs/heads/main",
    "ref_type": "branch",
    "ref_protected": "true",
    "sha": "4c2b7de91f0a8c3d5e6f7a8b9c0d1e2f3a4b5c6d",
    "actor": "ci-bot-acme",
    "actor_id": "77219",
    "event_name": "push",
    "environment": "production",
    "workflow": "deploy-production",
    "workflow_ref": "acme-corp/legacy-service/.github/workflows/deploy.yml@refs/heads/main",
    "workflow_sha": "4c2b7de91f0a8c3d5e6f7a8b9c0d1e2f3a4b5c6d",
    "job_workflow_ref": "acme-corp/legacy-service/.github/workflows/deploy.yml@refs/heads/main",
    "job_workflow_sha": "4c2b7de91f0a8c3d5e6f7a8b9c0d1e2f3a4b5c6d",
    "runner_environment": "self-hosted",
}


def _other_repo_claims(sub, repository, owner, repo_id, owner_id):
    return {
        "sub": sub,
        "aud": OIDC_HOST,
        "iss": f"https://{OIDC_HOST}",
        "repository": repository,
        "repository_owner": owner,
        "repository_id": repo_id,
        "repository_owner_id": owner_id,
        "repository_visibility": "private",
        "ref": "refs/heads/main",
        "ref_type": "branch",
        "ref_protected": "false",
        "sha": "0000111122223333444455556666777788889999",
        "actor": "ci-bot-acme",
        "actor_id": "77219",
        "event_name": "push",
        "environment": "production",
        "workflow": "deploy-production",
        "workflow_ref": f"{repository}/.github/workflows/deploy.yml@refs/heads/main",
        "workflow_sha": "0000111122223333444455556666777788889999",
        "job_workflow_ref": f"{repository}/.github/workflows/deploy.yml@refs/heads/main",
        "job_workflow_sha": "0000111122223333444455556666777788889999",
        "runner_environment": "self-hosted",
    }


MUST_BE_DENIED = [
    _other_repo_claims(
        "repo:acme-corp@1042/internal-tools@77104:ref:refs/heads/main",
        "acme-corp@1042/internal-tools@77104",
        "acme-corp@1042",
        "77104",
        "1042",
    ),
    _other_repo_claims(
        "repo:contoso-labs@5501/payments-api-fork@99012:ref:refs/heads/main",
        "contoso-labs@5501/payments-api-fork@99012",
        "contoso-labs@5501",
        "99012",
        "5501",
    ),
    _other_repo_claims(
        "repo:acme-corp/legacy-service-sandbox:ref:refs/heads/main",
        "acme-corp/legacy-service-sandbox",
        "acme-corp",
        "41999",
        "1042",
    ),
]


# ---------------------------------------------------------------------------
# minimal IAM trust-policy evaluator for sts:AssumeRoleWithWebIdentity
# ---------------------------------------------------------------------------


def _as_list(value):
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _condition_satisfied(condition: dict, claims: dict) -> bool:
    """True when every condition block is satisfied by the claim set."""
    for operator, mapping in (condition or {}).items():
        base = operator.split(":")[-1]
        for raw_key, raw_values in (mapping or {}).items():
            key = str(raw_key).lower()
            if not key.startswith(CLAIM_PREFIX):
                # condition on a key this federation flow never supplies
                return False
            claim_name = key[len(CLAIM_PREFIX) :]
            values = [str(v) for v in _as_list(raw_values)]
            if base == "Null":
                wants_absent = values[0].strip().lower() == "true"
                if (claim_name not in claims) != wants_absent:
                    return False
                continue
            if claim_name not in claims:
                return False
            actual = claims[claim_name]
            if base == "StringEquals":
                ok = any(v == actual for v in values)
            elif base == "StringEqualsIgnoreCase":
                ok = any(v.lower() == actual.lower() for v in values)
            elif base == "StringLike":
                ok = any(fnmatch.fnmatchcase(actual, v) for v in values)
            elif base == "StringNotEquals":
                ok = all(v != actual for v in values)
            elif base == "StringNotEqualsIgnoreCase":
                ok = all(v.lower() != actual.lower() for v in values)
            elif base == "StringNotLike":
                ok = all(not fnmatch.fnmatchcase(actual, v) for v in values)
            else:
                ok = False
            if not ok:
                return False
    return True


def _web_identity_statements(doc: dict, provider_arn: str):
    for statement in _as_list(doc.get("Statement", [])):
        if "NotAction" in statement or "NotPrincipal" in statement:
            continue
        actions = [str(a).lower() for a in _as_list(statement.get("Action"))]
        if not any(
            a in ("sts:assumerolewithwebidentity", "sts:*", "*") for a in actions
        ):
            continue
        principal = statement.get("Principal") or {}
        if not isinstance(principal, dict):
            continue
        federated = [str(f) for f in _as_list(principal.get("Federated"))]
        if provider_arn not in federated:
            continue
        yield statement


def federation_allowed(doc: dict, provider_arn: str, claims: dict) -> bool:
    statements = list(_web_identity_statements(doc, provider_arn))
    for statement in statements:
        if statement.get("Effect") == "Deny" and _condition_satisfied(
            statement.get("Condition", {}), claims
        ):
            return False
    return any(
        statement.get("Effect") == "Allow"
        and _condition_satisfied(statement.get("Condition", {}), claims)
        for statement in statements
    )


def _trust_doc(role_name: str) -> dict:
    iam = session.client("iam")
    return iam.get_role(RoleName=role_name)["Role"]["AssumeRolePolicyDocument"]


def _provider_arn() -> str:
    if OIDC_PROVIDER_ARN:
        return OIDC_PROVIDER_ARN
    account = session.client("sts").get_caller_identity()["Account"]
    return f"arn:aws:iam::{account}:oidc-provider/{OIDC_HOST}"


# ---------------------------------------------------------------------------
# criteria
# ---------------------------------------------------------------------------


@criterion(
    description="payments-api id_token (immutable-id subject, GitHub audience) is now accepted by the deploy role trust policy"
)
def payments_api_federation_allowed(workspace: Path) -> bool:
    try:
        return federation_allowed(
            _trust_doc(DEPLOY_ROLE_NAME), _provider_arn(), PAYMENTS_API_CLAIMS
        )
    except (ClientError, KeyError, TypeError):
        return False


@criterion(
    description="legacy-service id_token (slug subject) is still accepted - no regression"
)
def legacy_service_federation_preserved(workspace: Path) -> bool:
    try:
        return federation_allowed(
            _trust_doc(DEPLOY_ROLE_NAME), _provider_arn(), LEGACY_SERVICE_CLAIMS
        )
    except (ClientError, KeyError, TypeError):
        return False


@criterion(description="no other GitHub repository can assume the deploy role")
def other_repositories_denied(workspace: Path) -> bool:
    try:
        doc = _trust_doc(DEPLOY_ROLE_NAME)
        provider = _provider_arn()
    except (ClientError, KeyError, TypeError):
        return False
    return all(
        not federation_allowed(doc, provider, claims) for claims in MUST_BE_DENIED
    )


def _canonical(value):
    """Return a canonical form suitable for equality: list-vs-scalar collapsed,
    dicts key-sorted, string-lists sorted so declaration order does not matter."""
    if isinstance(value, dict):
        return {k: _canonical(value[k]) for k in sorted(value.keys())}
    if isinstance(value, list):
        canon = [_canonical(v) for v in value]
        if all(isinstance(v, str) for v in canon):
            return sorted(canon)
        return canon
    return value


def _canonical_condition_values(condition: dict) -> dict:
    """Normalise a Condition block: every value becomes a sorted list of strings."""
    out: dict = {}
    for operator, mapping in (condition or {}).items():
        norm_map: dict = {}
        for key, val in (mapping or {}).items():
            values = _as_list(val)
            norm_map[str(key)] = sorted(str(v) for v in values)
        out[str(operator)] = {k: norm_map[k] for k in sorted(norm_map)}
    return {k: out[k] for k in sorted(out)}


def _canonical_statement(statement: dict) -> dict:
    """Canonicalise a single trust-policy statement for exact-equality comparison."""
    canon = {}
    for key, value in statement.items():
        if key == "Condition":
            canon[key] = _canonical_condition_values(value)
        elif key == "Principal" and isinstance(value, dict):
            canon[key] = {
                k: sorted(str(v) for v in _as_list(v_list))
                for k, v_list in sorted(value.items())
            }
        elif key == "Action":
            canon[key] = sorted(str(v) for v in _as_list(value))
        else:
            canon[key] = _canonical(value)
    return {k: canon[k] for k in sorted(canon)}


def _canonical_policy(doc: dict) -> dict:
    statements = [_canonical_statement(s) for s in _as_list(doc.get("Statement", []))]
    statements_sorted = sorted(statements, key=lambda s: json.dumps(s, sort_keys=True))
    return {
        "Version": doc.get("Version"),
        "Statement": statements_sorted,
    }


def _baseline_staging_trust(account: str) -> dict:
    provider = f"arn:aws:iam::{account}:oidc-provider/{OIDC_HOST}"
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "GitHubActionsPaymentsApiStaging",
                "Effect": "Allow",
                "Principal": {"Federated": provider},
                "Action": "sts:AssumeRoleWithWebIdentity",
                "Condition": {
                    "StringLike": {
                        f"{OIDC_HOST}:sub": [
                            "repo:acme-corp@1042/payments-api-staging@88931:*"
                        ]
                    },
                    "StringEquals": {
                        f"{OIDC_HOST}:aud": "token.actions.githubusercontent.com"
                    },
                },
            }
        ],
    }


def _baseline_audit_trust(account: str) -> dict:
    provider = f"arn:aws:iam::{account}:oidc-provider/{OIDC_HOST}"
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "GitHubActionsAuditByRepositoryId",
                "Effect": "Allow",
                "Principal": {"Federated": provider},
                "Action": "sts:AssumeRoleWithWebIdentity",
                "Condition": {
                    "StringLike": {
                        f"{OIDC_HOST}:sub": [
                            "repo:acme-corp@1042/internal-tools@77104:*"
                        ]
                    },
                    "StringEquals": {
                        f"{OIDC_HOST}:aud": "token.actions.githubusercontent.com",
                        f"{OIDC_HOST}:repository_owner_id": "1042",
                        f"{OIDC_HOST}:repository_id": "77104",
                    },
                },
            }
        ],
    }


@criterion(
    description="deploy role permissions were not widened and the distractor roles were left alone"
)
def blast_radius_contained(workspace: Path) -> bool:
    iam = session.client("iam")
    try:
        doc = iam.get_role_policy(
            RoleName=DEPLOY_ROLE_NAME, PolicyName=DEPLOY_POLICY_NAME
        )["PolicyDocument"]
    except ClientError:
        return False

    actions_seen = set()
    for statement in _as_list(doc.get("Statement", [])):
        if statement.get("Effect") != "Allow":
            continue
        actions = [str(a) for a in _as_list(statement.get("Action"))]
        resources = [str(r) for r in _as_list(statement.get("Resource"))]
        actions_seen.update(actions)
        for action in actions:
            if action == "*" or re.match(r"^[a-zA-Z0-9-]+:\*$", action):
                return False
        if "*" in resources and actions != ["ecr:GetAuthorizationToken"]:
            return False
    if not {"s3:PutObject", "ecr:PutImage"}.issubset(actions_seen):
        return False

    try:
        if (
            len(
                iam.list_attached_role_policies(RoleName=DEPLOY_ROLE_NAME).get(
                    "AttachedPolicies", []
                )
            )
            != 0
        ):
            return False
        if iam.list_role_policies(RoleName=DEPLOY_ROLE_NAME).get("PolicyNames", []) != [
            DEPLOY_POLICY_NAME
        ]:
            return False
    except ClientError:
        return False

    # the correctly configured staging / audit roles must be BYTE-EQUAL to their baseline
    try:
        account = session.client("sts").get_caller_identity()["Account"]
        staging = _trust_doc(STAGING_ROLE_NAME)
        audit = _trust_doc(AUDIT_ROLE_NAME)
    except ClientError:
        return False
    if _canonical_policy(staging) != _canonical_policy(
        _baseline_staging_trust(account)
    ):
        return False
    if _canonical_policy(audit) != _canonical_policy(_baseline_audit_trust(account)):
        return False
    return True


_NARROW_SUB_RE = re.compile(r"^repo:[A-Za-z0-9._@\-]+/[A-Za-z0-9._@\-]+(?::.*)?$")


@criterion(
    description="the deploy role statement that accepts the payments-api id_token pins the immutable repository_id AND repository_owner_id from the JWT - sub alone is not enough"
)
def payments_pins_immutable_ids(workspace: Path) -> bool:
    """Any Allow statement that admits PAYMENTS_API_CLAIMS must additionally pin
    both `repository_id` and `repository_owner_id` via StringEquals to the exact
    numeric values from the id_token (88317 / 1042)."""
    try:
        doc = _trust_doc(DEPLOY_ROLE_NAME)
        provider = _provider_arn()
    except (ClientError, KeyError, TypeError):
        return False
    for statement in _web_identity_statements(doc, provider):
        if statement.get("Effect") != "Allow":
            continue
        if not _condition_satisfied(
            statement.get("Condition", {}), PAYMENTS_API_CLAIMS
        ):
            continue
        pins_repo_id = False
        pins_owner_id = False
        for operator, mapping in (statement.get("Condition") or {}).items():
            if str(operator).split(":")[-1] != "StringEquals":
                continue
            for key, values in (mapping or {}).items():
                key_l = str(key).lower()
                vals = [str(v) for v in _as_list(values)]
                if key_l.endswith(":repository_id") and vals == ["88317"]:
                    pins_repo_id = True
                if key_l.endswith(":repository_owner_id") and vals == ["1042"]:
                    pins_owner_id = True
        if pins_repo_id and pins_owner_id:
            return True
    return False


@criterion(
    description="every sub pattern on the deploy role names a specific repository - no org-level or catch-all wildcards"
)
def sub_patterns_narrow_enough(workspace: Path) -> bool:
    try:
        doc = _trust_doc(DEPLOY_ROLE_NAME)
        provider = _provider_arn()
    except (ClientError, KeyError, TypeError):
        return False
    for statement in _web_identity_statements(doc, provider):
        if statement.get("Effect") != "Allow":
            continue
        for operator, mapping in (statement.get("Condition") or {}).items():
            base = str(operator).split(":")[-1]
            # Only inspect Sub-related string operators; skip Bool/Null/etc.
            if not base.startswith("String"):
                continue
            for key, values in (mapping or {}).items():
                if not str(key).lower().endswith(":sub"):
                    continue
                for value in _as_list(values):
                    v = str(value)
                    if not _NARROW_SUB_RE.match(v):
                        return False
                    # additionally: no wildcards that would match the "must be denied" set
                    for other in MUST_BE_DENIED:
                        if fnmatch.fnmatchcase(other["sub"], v):
                            return False
    return True


@criterion(
    description="release orchestrator lambda can still assume the deploy role with sts:AssumeRole"
)
def orchestrator_still_functional(workspace: Path) -> bool:
    try:
        lam = session.client("lambda")
        resp = lam.invoke(
            FunctionName=ORCHESTRATOR_FUNCTION_NAME,
            InvocationType="RequestResponse",
            Payload=json.dumps({"source": "verifier"}).encode(),
        )
        payload = json.loads(resp["Payload"].read() or b"{}")
    except (ClientError, ValueError):
        return False
    return all(
        [
            resp.get("FunctionError") is None,
            payload.get("statusCode") == 200,
            DEPLOY_ROLE_NAME in str(payload.get("assumedRoleArn", "")),
            int(payload.get("artifactCount", 0)) >= 1,
        ]
    )


@criterion(
    description="GitHub OIDC identity provider still registers the audience the workflows request"
)
def oidc_provider_intact(workspace: Path) -> bool:
    try:
        iam = session.client("iam")
        provider = iam.get_open_id_connect_provider(
            OpenIDConnectProviderArn=_provider_arn()
        )
    except ClientError:
        return False
    return all(
        [
            provider.get("Url") == OIDC_HOST,
            OIDC_HOST in provider.get("ClientIDList", []),
            len(provider.get("ThumbprintList", [])) >= 1,
        ]
    )
