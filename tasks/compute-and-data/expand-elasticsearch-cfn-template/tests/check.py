"""Programmatic verifier for expand-elasticsearch-cfn-template."""

import json
import os
from pathlib import Path

import boto3
import yaml
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_REGION", "us-east-1")
BUCKET_NAME = os.environ.get("BUCKET_NAME", "")

AGENT_OUTPUT_PATH = Path("/logs/agent/agent-output.json")
AGENT_OUTPUT: dict = {}
if AGENT_OUTPUT_PATH.exists():
    try:
        AGENT_OUTPUT = json.loads(AGENT_OUTPUT_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        pass

TEMPLATE_KEY = AGENT_OUTPUT.get("template_key", "")


class _CfnLoader(yaml.SafeLoader):
    """SafeLoader that tolerates CloudFormation intrinsic short tags
    (!Ref, !Sub, !GetAtt, !FindInMap, ...). Each tag is preserved as its CFN
    long form {"Fn::<tag>": value} so intrinsic *usage* (e.g. a !FindInMap into
    a named mapping) can be detected structurally, matching how the same
    template written in JSON parses."""


def _cfn_multi(loader, tag_suffix, node):
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node, deep=True)
    else:
        value = loader.construct_mapping(node, deep=True)
    return {f"Fn::{tag_suffix}": value}


_CfnLoader.add_multi_constructor("!", _cfn_multi)


def _parse_cfn_yaml(body: str):
    """Parse CFN-YAML using the SafeLoader subclass above.

    Drives the SafeLoader subclass directly instead of going through the
    ``yaml`` module's generic load entry point. ``_CfnLoader`` derives from
    ``yaml.SafeLoader`` so no arbitrary Python objects are ever constructed;
    driving the loader directly also keeps static scanners from flagging a
    generic unsafe load.
    """
    loader = _CfnLoader(body)
    try:
        return loader.get_single_data()
    finally:
        loader.dispose()


def _load_template() -> dict | None:
    """Fetch the agent's template from S3 and parse it as JSON or CFN-YAML.
    Returns the parsed dict, or None if missing/unparseable."""
    if not BUCKET_NAME or not TEMPLATE_KEY:
        return None
    try:
        resp = boto3.client("s3", region_name=REGION).get_object(
            Bucket=BUCKET_NAME, Key=TEMPLATE_KEY
        )
        body = resp["Body"].read().decode("utf-8")
    except ClientError:
        return None
    for parse in (json.loads, _parse_cfn_yaml):
        try:
            parsed = parse(body)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            continue
    return None


def _references_map(node, map_name: str) -> bool:
    """True if `node` contains an Fn::FindInMap whose first argument is
    `map_name` (covers CFN JSON, YAML long form, and the !FindInMap short tag)."""
    if isinstance(node, dict):
        fim = node.get("Fn::FindInMap")
        if isinstance(fim, list) and fim and fim[0] == map_name:
            return True
        return any(_references_map(v, map_name) for v in node.values())
    if isinstance(node, list):
        return any(_references_map(v, map_name) for v in node)
    return False


@criterion(description="Agent output contains template_key")
def output_contract(workspace: Path) -> bool:
    return bool(TEMPLATE_KEY)


@criterion(description="Template exists in S3 bucket")
def template_exists(workspace: Path) -> bool:
    if not BUCKET_NAME or not TEMPLATE_KEY:
        return False
    try:
        s3 = boto3.client("s3", region_name=REGION)
        s3.head_object(Bucket=BUCKET_NAME, Key=TEMPLATE_KEY)
        return True
    except ClientError:
        return False


@criterion(description="Template parses (JSON or CFN-YAML) and has a Resources section")
def template_valid(workspace: Path) -> bool:
    template = _load_template()
    return isinstance(template, dict) and (
        "Resources" in template or "resources" in template
    )


@criterion(
    description="Multi-region: RegionMap mapping defines us-east-1 and us-west-2"
)
def has_multi_region(workspace: Path) -> bool:
    template = _load_template()
    if not isinstance(template, dict):
        return False
    region_map = (template.get("Mappings") or {}).get("RegionMap")
    if not isinstance(region_map, dict):
        return False
    regions = {k.lower() for k in region_map}
    return {"us-east-1", "us-west-2"} <= regions


@criterion(
    description="Multi-stage: StageConfig mapping defines alpha, beta, and gamma"
)
def has_multi_stage(workspace: Path) -> bool:
    template = _load_template()
    if not isinstance(template, dict):
        return False
    stage_config = (template.get("Mappings") or {}).get("StageConfig")
    if not isinstance(stage_config, dict):
        return False
    stages = {k.lower() for k in stage_config}
    return {"alpha", "beta", "gamma"} <= stages


@criterion(description="Domain consumes RegionMap and StageConfig via Fn::FindInMap")
def mappings_consumed(workspace: Path) -> bool:
    template = _load_template()
    if not isinstance(template, dict):
        return False
    return _references_map(template, "RegionMap") and _references_map(
        template, "StageConfig"
    )
