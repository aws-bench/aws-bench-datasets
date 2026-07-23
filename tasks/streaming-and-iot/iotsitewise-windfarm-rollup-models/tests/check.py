"""Programmatic verifier for iotsitewise-windfarm-rollup-models.

Validates the agent built a WindFarmModel + WindTurbineModel hierarchy
with a fleet-average rollup metric over the child's ActivePower property.

Per AWS docs:
  - https://docs.aws.amazon.com/iot-sitewise/latest/userguide/metrics.html
  - https://docs.aws.amazon.com/boto3/latest/reference/services/iotsitewise/client/describe_asset_model.html
"""

import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
PARENT_NAME = "WindFarmModel"
CHILD_NAME = "WindTurbineModel"
HIERARCHY_NAME = "Turbines"
PARENT_METRIC_NAME = "FleetAverageActivePower"
CHILD_PROPERTY_NAME = "ActivePower"
PARENT_MEASUREMENT_NAME = "TotalActivePower"

# Accept either ISO-8601 ("PT5M") or shorthand ("5m"). Normalize before
# compare. The CDK docs note both forms appear in different surfaces.
_FIVE_MIN_FORMS = {"5m", "PT5M", "pt5m"}


def _client():
    return boto3.client("iotsitewise", region_name=REGION)


def _list_all_models(client) -> list[dict]:
    """Walk the paginator since the account may have other models."""
    out: list[dict] = []
    try:
        paginator = client.get_paginator("list_asset_models")
        for page in paginator.paginate():
            out.extend(page.get("assetModelSummaries", []))
    except ClientError:
        pass
    return out


def _find_by_name(models: list[dict], name: str) -> dict | None:
    return next((m for m in models if m.get("name") == name), None)


def _describe(client, model_id: str) -> dict | None:
    try:
        return client.describe_asset_model(assetModelId=model_id)
    except ClientError:
        return None


@criterion(
    description="WindTurbineModel exists with an ActivePower measurement (DOUBLE)"
)
def child_model_correct(workspace: Path) -> bool:
    client = _client()
    summary = _find_by_name(_list_all_models(client), CHILD_NAME)
    if summary is None:
        return False
    desc = _describe(client, summary["id"])
    if desc is None:
        return False
    for prop in desc.get("assetModelProperties", []):
        if prop.get("name") != CHILD_PROPERTY_NAME:
            continue
        if prop.get("dataType") != "DOUBLE":
            return False
        return "measurement" in (prop.get("type") or {})
    return False


@criterion(
    description="WindFarmModel exists with TotalActivePower measurement and a Turbines hierarchy -> WindTurbineModel"
)
def parent_model_correct(workspace: Path) -> bool:
    client = _client()
    models = _list_all_models(client)
    parent_summary = _find_by_name(models, PARENT_NAME)
    child_summary = _find_by_name(models, CHILD_NAME)
    if parent_summary is None or child_summary is None:
        return False
    parent = _describe(client, parent_summary["id"])
    if parent is None:
        return False

    # TotalActivePower measurement (DOUBLE).
    has_measurement = False
    for prop in parent.get("assetModelProperties", []):
        if prop.get("name") != PARENT_MEASUREMENT_NAME:
            continue
        if prop.get("dataType") != "DOUBLE":
            return False
        if "measurement" in (prop.get("type") or {}):
            has_measurement = True
            break
    if not has_measurement:
        return False

    # Turbines hierarchy -> child.
    return any(
        h.get("name") == HIERARCHY_NAME
        and h.get("childAssetModelId") == child_summary["id"]
        for h in parent.get("assetModelHierarchies", [])
    )


@criterion(
    description="parent's FleetAverageActivePower metric variable references child's ActivePower (directly, or via a child-side metric that itself references ActivePower) through the Turbines hierarchy"
)
def metric_references_child(workspace: Path) -> bool:
    """AWS IoT SiteWise enforces a rule: a
    parent model's metric can only reference *metric* properties on a
    child model, not raw measurements. So a correct solution may
    include an intermediate metric on the child (e.g. ActivePowerAvg)
    that itself references the child's ActivePower measurement, with
    the parent's metric pointing at that intermediate. We accept either
    shape:

      direct:    parent.metric.var.value -> {propertyId=child.ActivePower.id,
                                             hierarchyId=Turbines.id}

      indirect:  parent.metric.var.value -> {propertyId=child.<some metric>.id,
                                             hierarchyId=Turbines.id}
                 where child.<some metric>.metric.variables references
                 child.ActivePower (no hierarchyId on the child-side var
                 since it's same-model).
    """
    client = _client()
    models = _list_all_models(client)
    parent_summary = _find_by_name(models, PARENT_NAME)
    child_summary = _find_by_name(models, CHILD_NAME)
    if parent_summary is None or child_summary is None:
        return False
    parent = _describe(client, parent_summary["id"])
    child = _describe(client, child_summary["id"])
    if parent is None or child is None:
        return False

    child_props = child.get("assetModelProperties", [])
    child_active_power_id = next(
        (p.get("id") for p in child_props if p.get("name") == CHILD_PROPERTY_NAME),
        None,
    )
    turbines_hierarchy_id = next(
        (
            h.get("id")
            for h in parent.get("assetModelHierarchies", [])
            if h.get("name") == HIERARCHY_NAME
        ),
        None,
    )
    if not child_active_power_id or not turbines_hierarchy_id:
        return False

    metric_prop = next(
        (
            p
            for p in parent.get("assetModelProperties", [])
            if p.get("name") == PARENT_METRIC_NAME
        ),
        None,
    )
    if metric_prop is None:
        return False
    parent_metric = (metric_prop.get("type") or {}).get("metric") or {}

    # Build set of child metric property ids that derive from ActivePower
    # (their metric.variables include a var whose value.propertyId is
    # child_active_power_id with no hierarchyId — same-model reference).
    child_metric_ids_from_active_power: set[str] = set()
    for cp in child_props:
        cmetric = (cp.get("type") or {}).get("metric") or {}
        for cvar in cmetric.get("variables") or []:
            cval = cvar.get("value") or {}
            # Same-model var: no hierarchyId, propertyId = ActivePower id
            if cval.get("propertyId") == child_active_power_id and not cval.get(
                "hierarchyId"
            ):
                child_metric_ids_from_active_power.add(cp.get("id") or "")
                break

    accepted_target_ids = {child_active_power_id} | child_metric_ids_from_active_power

    for var in parent_metric.get("variables") or []:
        val = var.get("value") or {}
        if (
            val.get("propertyId") in accepted_target_ids
            and val.get("hierarchyId") == turbines_hierarchy_id
        ):
            return True
    return False


@criterion(
    description="parent's FleetAverageActivePower metric tumbling window is 5 minutes"
)
def metric_window_5_minutes(workspace: Path) -> bool:
    client = _client()
    summary = _find_by_name(_list_all_models(client), PARENT_NAME)
    if summary is None:
        return False
    parent = _describe(client, summary["id"])
    if parent is None:
        return False
    metric_prop = next(
        (
            p
            for p in parent.get("assetModelProperties", [])
            if p.get("name") == PARENT_METRIC_NAME
        ),
        None,
    )
    if metric_prop is None:
        return False
    metric = (metric_prop.get("type") or {}).get("metric") or {}
    window = (metric.get("window") or {}).get("tumbling") or {}
    interval = window.get("interval") or ""
    return interval in _FIVE_MIN_FORMS
