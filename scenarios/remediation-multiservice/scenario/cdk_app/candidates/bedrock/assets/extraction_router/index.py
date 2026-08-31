"""DocIntel structured-extraction router.

Every document class is extracted through this single code path:

    profile (DynamoDB)  ->  document text (S3)  ->  bedrock:Converse with a
    tool definition  ->  structured fields  ->  run ledger (DynamoDB) + metrics

Two invocation shapes are supported:

* ``{"mode": "sweep"}``            - run every enabled profile once (scheduled/manual)
* S3 ``ObjectCreated`` notification - run the single profile encoded in the key
  prefix ``incoming/<profileId>/<file>.txt``

Provider errors are never allowed to fault the invocation: they are recorded on
the run row and counted, so the async S3 path does not retry a request that can
never succeed.
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.parse
import uuid
from decimal import Decimal
from typing import Any, Dict, List, Optional

import boto3
import botocore
from botocore.config import Config
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def _classify(code: str, message: str) -> str:
    """Redact provider messages to stable classification codes for the run ledger.

    The full provider text still reaches CloudWatch Logs as a
    ``PROVIDER_MESSAGE_DETAIL`` event, but the persisted run row only carries a
    coarse classification so downstream dashboards do not depend on volatile
    provider strings.
    """
    if not isinstance(code, str):
        code = "UnknownError"
    if not isinstance(message, str):
        return code
    if code == "ValidationException":
        lowered = message.lower()
        if any(
            token in lowered
            for token in (
                "toolconfig",
                "toolchoice",
                "tool_choice",
                "tool choice",
                "tool use",
            )
        ):
            return "provider_rejected_tool_config"
    return code


PROFILES_TABLE = os.environ["PROFILES_TABLE"]
RUNS_TABLE = os.environ["RUNS_TABLE"]
DOCUMENTS_BUCKET = os.environ["DOCUMENTS_BUCKET"]
METRIC_NAMESPACE = os.environ["METRIC_NAMESPACE"]
SERVICE_NAME = os.environ.get("SERVICE_NAME", "docintel-extraction")
RUN_TTL_DAYS = int(os.environ.get("RUN_TTL_DAYS", "3"))

_boto_cfg = Config(
    retries={"max_attempts": 4, "mode": "adaptive"}, read_timeout=60, connect_timeout=10
)

_ddb = boto3.resource("dynamodb")
_profiles = _ddb.Table(PROFILES_TABLE)
_runs = _ddb.Table(RUNS_TABLE)
_s3 = boto3.client("s3", config=_boto_cfg)
_cw = boto3.client("cloudwatch", config=_boto_cfg)
_bedrock = boto3.client("bedrock-runtime", config=_boto_cfg)


def _log(level: int, event: str, **fields: Any) -> None:
    payload = {"service": SERVICE_NAME, "event": event}
    payload.update(fields)
    logger.log(level, json.dumps(payload, default=str))


def _load_profile(profile_id: str) -> Optional[Dict[str, Any]]:
    resp = _profiles.get_item(Key={"profileId": profile_id})
    return resp.get("Item")


def _load_enabled_profiles() -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    kwargs: Dict[str, Any] = {}
    while True:
        page = _profiles.scan(**kwargs)
        items.extend(page.get("Items", []))
        if "LastEvaluatedKey" not in page:
            break
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    enabled = [i for i in items if bool(i.get("enabled", False))]
    return sorted(enabled, key=lambda i: i["profileId"])


def _read_document(key: str) -> str:
    obj = _s3.get_object(Bucket=DOCUMENTS_BUCKET, Key=key)
    return obj["Body"].read().decode("utf-8")


def _build_tool_config(profile: Dict[str, Any]) -> Dict[str, Any]:
    """Assemble toolConfig exactly the same way for every document class."""
    tool_name = profile["toolName"]
    schema = json.loads(profile["toolSchema"])
    tool_config: Dict[str, Any] = {
        "tools": [
            {
                "toolSpec": {
                    "name": tool_name,
                    "description": profile.get(
                        "toolDescription",
                        "Record the structured fields extracted from the document.",
                    ),
                    "inputSchema": {"json": schema},
                }
            }
        ]
    }
    strategy = str(profile.get("routingStrategy", "strict"))
    if strategy == "strict":
        # Pin the model to the single extraction tool so the response is always
        # structured JSON and downstream parsing never has to handle prose.
        tool_config["toolChoice"] = {"tool": {"name": tool_name}}
    elif strategy == "open":
        tool_config["toolChoice"] = {"any": {}}
    elif strategy == "auto":
        tool_config["toolChoice"] = {"auto": {}}
    # strategy == "none" -> omit toolChoice entirely (provider default)
    return tool_config


def _put_metric(metric_name: str, profile_id: str, model_id: str) -> None:
    _cw.put_metric_data(
        Namespace=METRIC_NAMESPACE,
        MetricData=[
            {"MetricName": metric_name, "Value": 1.0, "Unit": "Count"},
            {
                "MetricName": metric_name,
                "Value": 1.0,
                "Unit": "Count",
                "Dimensions": [{"Name": "ProfileId", "Value": profile_id}],
            },
            {
                "MetricName": metric_name,
                "Value": 1.0,
                "Unit": "Count",
                "Dimensions": [{"Name": "ModelId", "Value": model_id}],
            },
        ],
    )


def _record_run(row: Dict[str, Any]) -> None:
    row = {k: v for k, v in row.items() if v is not None and v != ""}
    _runs.put_item(Item=row)


def _run_profile(
    profile: Dict[str, Any], source: str, document_key: Optional[str] = None
) -> Dict[str, Any]:
    profile_id = profile["profileId"]
    model_id = profile["modelId"]
    routing_strategy = str(profile.get("routingStrategy", "strict"))
    key = document_key or profile["sampleKey"]
    started = time.time()
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started))
    run_id = f"{started_at}#{uuid.uuid4().hex[:8]}"

    tool_config = _build_tool_config(profile)
    document_text = _read_document(key)
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "text": (
                        f"{profile.get('promptPreamble', 'Extract the requested fields from the document below.')}\n\n"
                        f"--- BEGIN DOCUMENT ---\n{document_text}\n--- END DOCUMENT ---"
                    )
                }
            ],
        }
    ]
    inference_config = {
        "maxTokens": int(profile.get("maxTokens", 512)),
        "temperature": float(str(profile.get("temperature", "0"))),
    }

    _log(
        logging.INFO,
        "EXTRACTION_STARTED",
        profileId=profile_id,
        documentClass=profile.get("documentClass"),
        modelId=model_id,
        routingStrategy=routing_strategy,
        toolName=profile["toolName"],
        documentKey=key,
        source=source,
        runId=run_id,
    )

    row: Dict[str, Any] = {
        "profileId": profile_id,
        "runId": run_id,
        "startedAt": started_at,
        "modelId": model_id,
        "routingStrategy": routing_strategy,
        "toolName": profile["toolName"],
        "documentKey": key,
        "documentClass": profile.get("documentClass"),
        "source": source,
        "expiresAt": int(started) + RUN_TTL_DAYS * 86400,
    }

    try:
        response = _bedrock.converse(
            modelId=model_id,
            messages=messages,
            inferenceConfig=inference_config,
            toolConfig=tool_config,
        )
    except ClientError as exc:
        err = exc.response.get("Error", {})
        code = err.get("Code", "UnknownError")
        message = err.get("Message", str(exc))
        latency = int((time.time() - started) * 1000)
        classification = _classify(code, message)
        row.update(
            {
                "status": "FAILED",
                "errorCode": code,
                # Redacted classification only — the full provider text is
                # emitted separately below and lives in CloudWatch Logs.
                "errorMessage": classification,
                "latencyMs": latency,
                "extractedFieldCount": 0,
            }
        )
        _record_run(row)
        _put_metric("ExtractionFailures", profile_id, model_id)
        # Operational log line stays terse; the provider message is emitted on
        # a distinct log event so the extraction dashboard scans a stable code.
        _log(
            logging.ERROR,
            "EXTRACTION_FAILED",
            profileId=profile_id,
            modelId=model_id,
            routingStrategy=routing_strategy,
            errorCode=code,
            classification=classification,
            runId=run_id,
            latencyMs=latency,
        )
        # Verbose detail event — kept out of the primary error stream so the
        # dashboard alarms filter on stable classification codes only.
        _log(
            logging.INFO,
            "PROVIDER_MESSAGE_DETAIL",
            profileId=profile_id,
            modelId=model_id,
            runId=run_id,
            errorCode=code,
            providerMessage=message,
        )
        return {
            "profileId": profile_id,
            "status": "FAILED",
            "errorCode": code,
            "runId": run_id,
        }

    latency = int((time.time() - started) * 1000)
    stop_reason = response.get("stopReason")
    fields: Dict[str, Any] = {}
    for block in response.get("output", {}).get("message", {}).get("content", []):
        if "toolUse" in block:
            fields = block["toolUse"].get("input") or {}
            break

    usage = response.get("usage", {})
    row.update(
        {
            "status": "SUCCEEDED" if fields else "NO_STRUCTURED_OUTPUT",
            "stopReason": stop_reason,
            "latencyMs": latency,
            "extractedFieldCount": len(fields),
            "extractedFields": json.dumps(fields, default=str)[:3500],
            "inputTokens": Decimal(str(usage.get("inputTokens", 0))),
            "outputTokens": Decimal(str(usage.get("outputTokens", 0))),
        }
    )
    _record_run(row)

    if fields:
        _put_metric("ExtractionSuccesses", profile_id, model_id)
        _log(
            logging.INFO,
            "EXTRACTION_SUCCEEDED",
            profileId=profile_id,
            modelId=model_id,
            routingStrategy=routing_strategy,
            stopReason=stop_reason,
            extractedFieldCount=len(fields),
            runId=run_id,
            latencyMs=latency,
        )
    else:
        _put_metric("ExtractionFailures", profile_id, model_id)
        _log(
            logging.ERROR,
            "EXTRACTION_FAILED",
            profileId=profile_id,
            modelId=model_id,
            routingStrategy=routing_strategy,
            errorCode="NoStructuredOutput",
            stopReason=stop_reason,
            runId=run_id,
            latencyMs=latency,
        )
    return {
        "profileId": profile_id,
        "status": row["status"],
        "stopReason": stop_reason,
        "runId": run_id,
    }


def _handle_s3_records(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    results = []
    for rec in records:
        key = urllib.parse.unquote_plus(rec["s3"]["object"]["key"])
        parts = key.split("/")
        if len(parts) < 3 or parts[0] != "incoming":
            _log(logging.WARNING, "UNROUTABLE_OBJECT", documentKey=key)
            continue
        profile_id = parts[1]
        profile = _load_profile(profile_id)
        if profile is None:
            _log(
                logging.WARNING,
                "UNKNOWN_PROFILE",
                profileId=profile_id,
                documentKey=key,
            )
            continue
        if not bool(profile.get("enabled", False)):
            _log(
                logging.WARNING,
                "PROFILE_DISABLED",
                profileId=profile_id,
                documentKey=key,
            )
            continue
        results.append(
            _run_profile(profile, source="s3-notification", document_key=key)
        )
    return results


def handler(event, context):  # noqa: ANN001, ANN201
    if isinstance(event, dict) and event.get("Records"):
        results = _handle_s3_records(event["Records"])
    else:
        label = (event or {}).get("runLabel", "manual")
        profile_ids = (event or {}).get("profileIds")
        profiles = _load_enabled_profiles()
        if profile_ids:
            wanted = set(profile_ids)
            profiles = [p for p in profiles if p["profileId"] in wanted]
        _log(
            logging.INFO,
            "SWEEP_STARTED",
            runLabel=label,
            profileCount=len(profiles),
            botocoreVersion=botocore.__version__,
        )
        results = [_run_profile(p, source=f"sweep:{label}") for p in profiles]
        failed = [r for r in results if r["status"] != "SUCCEEDED"]
        _log(
            logging.INFO,
            "SWEEP_COMPLETED",
            runLabel=label,
            total=len(results),
            failed=len(failed),
            failedProfiles=[r["profileId"] for r in failed],
        )

    return {"statusCode": 200, "results": results}
