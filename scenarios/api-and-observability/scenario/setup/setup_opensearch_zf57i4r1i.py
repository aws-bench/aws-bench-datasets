"""
Setup script for stack opensearch-zf57i4r1i (api-and-observability).
Seeds a document into the OpenSearch index,
makes the GET request the user asks about, and ensures audit logging is enabled
so real audit events are generated in CloudWatch.
"""

import json
import sys
import time
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

import boto3
from botocore.config import Config


STACK_NAME = "api-and-observability-opensearch-zf57i4r1i-us-east-1"
DOCUMENT_ID = "changeset-a3f8b921"
INDEX_NAME = "changesets"

_config = Config(connect_timeout=5, read_timeout=60)


def _invoke_opensearch_request(
    lambda_client, function_name: str, method: str, path: str, body=None
) -> Dict:
    response = lambda_client.invoke(
        FunctionName=function_name,
        InvocationType="RequestResponse",
        Payload=json.dumps({"method": method, "path": path, "body": body}).encode(),
    )
    payload = json.loads(response["Payload"].read().decode())
    if response.get("FunctionError"):
        raise RuntimeError(f"OpenSearch setup probe failed: {payload}")
    return payload


def _ensure_audit_logging_via_probe(request_fn) -> None:
    """Enable Security Plugin audit logging through the in-VPC setup probe."""
    current = request_fn("GET", "/_opendistro/_security/api/audit")
    cfg = current.get("body", {}).get("config", {})

    already_enabled = (
        cfg.get("enabled") is True
        and cfg.get("audit", {}).get("enable_rest") is True
        and cfg.get("audit", {}).get("enable_transport") is True
        and cfg.get("audit", {}).get("disabled_rest_categories") == []
        and cfg.get("audit", {}).get("disabled_transport_categories") == []
    )
    if already_enabled:
        print("Audit logging already fully enabled, skipping PATCH")
        return

    patch_ops = [
        {"op": "replace", "path": "/config/enabled", "value": True},
        {"op": "replace", "path": "/config/audit/enable_rest", "value": True},
        {"op": "replace", "path": "/config/audit/enable_transport", "value": True},
        {
            "op": "replace",
            "path": "/config/audit/disabled_rest_categories",
            "value": [],
        },
        {
            "op": "replace",
            "path": "/config/audit/disabled_transport_categories",
            "value": [],
        },
    ]
    result = request_fn("PATCH", "/_opendistro/_security/api/audit", patch_ops)
    if result.get("status_code") != 200:
        raise RuntimeError(f"Failed to enable audit logging: {result}")
    print("Audit logging enabled")


def _find_audit_stream(logs_client, audit_log_group_name: str) -> str:
    """Find the OpenSearch-managed audit log stream."""
    streams = logs_client.describe_log_streams(
        logGroupName=audit_log_group_name,
        orderBy="LastEventTime",
        descending=True,
        limit=10,
    )
    for s in streams.get("logStreams", []):
        if s["logStreamName"].endswith("-audit-logs"):
            return s["logStreamName"]
    raise RuntimeError("No audit log stream found")


def _wait_for_audit_events(
    audit_log_group_name: str, session: boto3.Session, region: str, timeout_s: int = 300
) -> bool:
    """Wait for audit events referencing the document to appear in CloudWatch."""
    logs_client = session.client("logs", config=_config, region_name=region)
    start = time.time()

    while time.time() - start < timeout_s:
        try:
            events = logs_client.get_log_events(
                logGroupName=audit_log_group_name,
                logStreamName=_find_audit_stream(logs_client, audit_log_group_name),
                startFromHead=False,
                limit=50,
            )
            for e in events.get("events", []):
                if DOCUMENT_ID in e.get("message", "") and "GET" in e.get(
                    "message", ""
                ):
                    print(
                        f"GET audit event for {DOCUMENT_ID} confirmed after {int(time.time() - start)}s"
                    )
                    return True
        except Exception:
            pass
        time.sleep(10)

    print(
        f"GET audit event for {DOCUMENT_ID} not found after {timeout_s}s",
        file=sys.stderr,
    )
    return False


def run(
    session: Optional[boto3.Session] = None,
    region: str = "us-east-1",
    **parameters,
) -> Dict[str, Any]:
    if not session:
        session = boto3.Session(profile_name="PRIMARY", region_name=region)

    cfn = session.client("cloudformation", config=_config, region_name=region)
    outputs = {
        o["OutputKey"]: o["OutputValue"]
        for o in cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]["Outputs"]
    }

    audit_log_group_name = outputs["AuditLogGroupName"]
    setup_probe_name = outputs["OpenSearchSetupProbeName"]
    lambda_client = session.client("lambda", config=_config, region_name=region)

    def request_fn(method: str, path: str, body=None) -> Dict:
        return _invoke_opensearch_request(
            lambda_client, setup_probe_name, method, path, body
        )

    # 1. Ensure audit logging is enabled
    try:
        _ensure_audit_logging_via_probe(request_fn)
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        return {"success": False, "output_values": None, "reason": str(e)}

    # 2. Create index (ignore if exists)
    create_result = request_fn(
        "PUT",
        f"/{INDEX_NAME}",
        {"settings": {"number_of_shards": 1, "number_of_replicas": 0}},
    )
    if create_result["status_code"] == 400:
        pass  # index already exists
    elif create_result["status_code"] not in (200, 201):
        print(f"Failed to create index {INDEX_NAME}: {create_result}", file=sys.stderr)
        return {
            "success": False,
            "output_values": None,
            "reason": f"Failed to create index {INDEX_NAME}: {create_result}",
        }
    else:
        print(f"Created index {INDEX_NAME}: {create_result['status_code']}")

    # 3. Index the document
    now = datetime.utcnow()
    doc = {
        "id": DOCUMENT_ID,
        "timestamp": (now - timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "status": "indexed",
    }
    put_result = request_fn("PUT", f"/{INDEX_NAME}/_doc/{DOCUMENT_ID}", doc)
    print(f"PUT {DOCUMENT_ID}: {put_result['status_code']}")

    # 4. Make the GET the user claims to have made
    get_result = request_fn("GET", f"/{INDEX_NAME}/_doc/{DOCUMENT_ID}")
    print(
        f"GET {DOCUMENT_ID}: {get_result['status_code']}, found={get_result['body'].get('found')}"
    )

    # 5. Wait for the GET audit event to land in CloudWatch
    if not _wait_for_audit_events(audit_log_group_name, session, region):
        return {
            "success": False,
            "output_values": None,
            "reason": f"GET audit event for {DOCUMENT_ID} not found after timeout",
        }

    return {"success": True, "output_values": None, "reason": None}


if __name__ == "__main__":
    try:
        result = run()
        print(json.dumps(result, indent=2))
        if not result.get("success"):
            sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        import traceback

        traceback.print_exc()
        sys.exit(1)
