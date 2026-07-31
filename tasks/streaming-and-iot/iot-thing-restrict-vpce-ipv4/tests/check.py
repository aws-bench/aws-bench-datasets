"""Programmatic verifier for iot-thing-restrict-vpce-ipv4.

Validates that the agent created an IoT policy restricting the thing's
data-plane actions to traffic originating from the pre-deployed IPv4-only
VPC endpoint, and attached the policy so it appears in
iot:GetEffectivePolicies for the thing.

AWS IoT Core does not support VPC endpoint policies -- confirmed by AWS
docs (https://docs.aws.amazon.com/iot/latest/developerguide/IoTCore-VPC.md).
The restriction lives entirely in the IoT policy document via the
aws:SourceVpce condition key. iot:TestAuthorization can't simulate that
context, so this verifier is a static policy-document audit: parse the
JSON and assert structure.

Two equivalent policy shapes are accepted:
  - Effect: Allow with Condition: StringEquals { aws:SourceVpce: <VPCE> }
  - Effect: Deny  with Condition: StringNotEquals { aws:SourceVpce: <VPCE> }
The four required actions (Connect/Publish/Subscribe/Receive) must each
be covered by at least one matching statement.
"""

import json
import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_REGION", "us-east-1")
THING_NAME = os.environ.get("THING_NAME", "")
VPCE_ID = os.environ.get("VPCE_ID", "")

REQUIRED_ACTIONS = {"iot:Connect", "iot:Publish", "iot:Subscribe", "iot:Receive"}

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    AGENT_OUTPUT = {}

REQUIRED_OUTPUT_KEYS = ("policy_name",)
CHOSEN_POLICY_NAME = AGENT_OUTPUT.get("policy_name") or ""


def _iot():
    return boto3.client("iot", region_name=REGION)


def _list_actions(stmt: dict) -> set[str]:
    """Action(s) on a statement, normalized into a set."""
    actions = stmt.get("Action") or stmt.get("action") or []
    if isinstance(actions, str):
        return {actions}
    return set(actions)


def _has_matching_vpce_condition(stmt: dict, vpce: str) -> bool:
    """True iff the statement's Condition pins aws:SourceVpce to `vpce`.

    Matches the two equivalent shapes:
      Effect=Allow, Condition.StringEquals.aws:SourceVpce = <VPCE>
      Effect=Deny,  Condition.StringNotEquals.aws:SourceVpce = <VPCE>
    """
    cond = stmt.get("Condition") or stmt.get("condition") or {}
    effect = (stmt.get("Effect") or stmt.get("effect") or "").lower()

    if effect == "allow":
        equals = cond.get("StringEquals") or cond.get("stringEquals") or {}
        val = equals.get("aws:SourceVpce")
        if isinstance(val, list):
            return vpce in val
        return val == vpce

    if effect == "deny":
        not_equals = cond.get("StringNotEquals") or cond.get("stringNotEquals") or {}
        val = not_equals.get("aws:SourceVpce")
        if isinstance(val, list):
            return vpce in val
        return val == vpce

    return False


def _list_thing_policies() -> set[str]:
    """Return policy names attached to any principal of THING_NAME.

    iot:GetEffectivePolicies requires `principal` (or cognito pool) -- it is
    not a thing-only API. The supported recipe is:
        list_thing_principals -> for each principal: list_attached_policies.
    """
    iot = _iot()
    names: set[str] = set()
    try:
        principals = iot.list_thing_principals(thingName=THING_NAME).get(
            "principals", []
        )
    except ClientError:
        return names
    for p_arn in principals:
        try:
            attached = iot.list_attached_policies(target=p_arn).get("policies", [])
        except ClientError:
            continue
        for p in attached:
            n = p.get("policyName")
            if n:
                names.add(n)
    return names


def _resolve_policy_document() -> dict | None:
    """Return the agent-reported policy's document. Falls back to direct
    get_policy if the policy isn't yet attached -- `policy_attached_to_thing`
    is the gate for "did the agent actually attach it"; this function lets
    `policy_restricts_to_vpce` diagnose the document independently.
    """
    name = CHOSEN_POLICY_NAME
    if not name:
        return None
    try:
        resp = _iot().get_policy(policyName=name)
    except ClientError:
        return None
    try:
        return json.loads(resp.get("policyDocument") or "{}")
    except json.JSONDecodeError:
        return None


@criterion(description="agent wrote agent-output.json with all required keys")
def output_contract_followed(workspace: Path) -> bool:
    return bool(AGENT_OUTPUT) and all(k in AGENT_OUTPUT for k in REQUIRED_OUTPUT_KEYS)


@criterion(
    description="agent's reported IoT policy is attached to a principal of the thing"
)
def policy_attached_to_thing(workspace: Path) -> bool:
    if not CHOSEN_POLICY_NAME or not THING_NAME:
        return False
    return CHOSEN_POLICY_NAME in _list_thing_policies()


@criterion(
    description="policy document restricts iot:Connect/Publish/Subscribe/Receive to the VPCE via aws:SourceVpce"
)
def policy_restricts_to_vpce(workspace: Path) -> bool:
    """Each required action must appear on at least one statement whose
    Condition pins aws:SourceVpce to the expected VPCE id (in either the
    Allow+StringEquals or Deny+StringNotEquals shape).
    """
    if not VPCE_ID:
        return False
    doc = _resolve_policy_document()
    if doc is None:
        return False

    statements = doc.get("Statement") or doc.get("statement") or []
    if isinstance(statements, dict):
        statements = [statements]

    covered: set[str] = set()
    for stmt in statements:
        if not _has_matching_vpce_condition(stmt, VPCE_ID):
            continue
        for act in _list_actions(stmt):
            if act == "iot:*" or act == "*":
                covered |= REQUIRED_ACTIONS
            elif act in REQUIRED_ACTIONS:
                covered.add(act)

    return REQUIRED_ACTIONS.issubset(covered)


@criterion(
    description="policy has NO unrestricted Allow on Connect/Publish/Subscribe/Receive (would otherwise nullify the VPCE restriction)"
)
def policy_no_unrestricted_allow(workspace: Path) -> bool:
    """An Allow statement with no aws:SourceVpce condition that grants
    one of the data-plane actions silently nullifies the
    Allow+StringEquals restriction (because IoT Core IAM logic is
    union-of-allows). Reject any policy with such a statement.

    The match is on actions actually present, not on Resource -- a
    granted action without a VPCE condition is permissive regardless of
    Resource.
    """
    doc = _resolve_policy_document()
    if doc is None:
        return False
    statements = doc.get("Statement") or doc.get("statement") or []
    if isinstance(statements, dict):
        statements = [statements]
    for stmt in statements:
        effect = (stmt.get("Effect") or stmt.get("effect") or "").lower()
        if effect != "allow":
            continue
        cond = stmt.get("Condition") or stmt.get("condition") or {}
        # If this Allow already pins to our VPCE, it's fine.
        if _has_matching_vpce_condition(stmt, VPCE_ID):
            continue
        # Look for any pinning to *any* SourceVpce condition (the agent
        # might have written an extra Allow for a different VPCE -- also
        # fine since it doesn't widen our intended bypass).
        equals = cond.get("StringEquals") or cond.get("stringEquals") or {}
        if equals.get("aws:SourceVpce"):
            continue
        # Allow without a SourceVpce pin: check whether it touches a
        # required action.
        actions = _list_actions(stmt)
        broad = any(a in {"iot:*", "*"} for a in actions)
        granular = bool(actions & REQUIRED_ACTIONS)
        if broad or granular:
            return False
    return True
