"""
Setup script for stack opensearch-zf57i4r1i (api-and-observability).
Seeds a document into the OpenSearch index,
makes the GET request the user asks about, and ensures audit logging is enabled
so real audit events are generated in CloudWatch.
"""

import json
import ssl
import sys
import time
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.config import Config
from botocore.credentials import Credentials


import urllib.error
import urllib.request


STACK_NAME = "api-and-observability-opensearch-zf57i4r1i-us-east-1"
DOCUMENT_ID = "changeset-a3f8b921"
INDEX_NAME = "changesets"

_config = Config(connect_timeout=5, read_timeout=60)


def _sign_request(
    method: str, url: str, body: Optional[str], credentials, region: str
) -> Dict[str, str]:
    request = AWSRequest(method=method, url=url, data=body)
    request.headers["Content-Type"] = "application/json"
    SigV4Auth(credentials, "es", region).add_auth(request)
    return dict(request.headers)


def _opensearch_request(
    method: str, endpoint: str, path: str, body=None, credentials=None, region: str = ""
) -> Dict:
    url = f"https://{endpoint}{path}"
    body_str = json.dumps(body) if body else None
    headers = _sign_request(method, url, body_str, credentials, region)
    ctx = ssl.create_default_context()
    req = urllib.request.Request(
        url,
        data=body_str.encode() if body_str else None,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=30) as response:
            response_body = response.read().decode()
            return {
                "status_code": response.status,
                "body": json.loads(response_body) if response_body else {},
            }
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        return {
            "status_code": e.code,
            "body": json.loads(error_body) if error_body else {},
        }


def _ensure_audit_logging(endpoint: str, credentials, region: str) -> None:
    """Enable Security Plugin audit logging if not already enabled."""
    current = _opensearch_request(
        "GET",
        endpoint,
        "/_opendistro/_security/api/audit",
        credentials=credentials,
        region=region,
    )
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
    result = _opensearch_request(
        "PATCH",
        endpoint,
        "/_opendistro/_security/api/audit",
        patch_ops,
        credentials,
        region,
    )
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
    domain_endpoint = outputs["OpenSearchDomainEndpoint"]
    opensearch_role_arn = outputs["OpenSearchReadWriteRoleArn"]

    print("Assuming OpenSearchReadWriteRole...")
    sts_client = session.client("sts", config=_config, region_name=region)
    assumed_role = sts_client.assume_role(
        RoleArn=opensearch_role_arn, RoleSessionName="setup-script-session"
    )

    creds = Credentials(
        access_key=assumed_role["Credentials"]["AccessKeyId"],
        secret_key=assumed_role["Credentials"]["SecretAccessKey"],
        token=assumed_role["Credentials"]["SessionToken"],
    )

    # 1. Ensure audit logging is enabled
    try:
        _ensure_audit_logging(domain_endpoint, creds, region)
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        return {"success": False, "output_values": None, "reason": str(e)}

    # 2. Create index (ignore if exists)
    create_result = _opensearch_request(
        "PUT",
        domain_endpoint,
        f"/{INDEX_NAME}",
        {"settings": {"number_of_shards": 1, "number_of_replicas": 0}},
        creds,
        region,
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
    put_result = _opensearch_request(
        "PUT", domain_endpoint, f"/{INDEX_NAME}/_doc/{DOCUMENT_ID}", doc, creds, region
    )
    print(f"PUT {DOCUMENT_ID}: {put_result['status_code']}")

    # 4. Make the GET the user claims to have made
    get_result = _opensearch_request(
        "GET", domain_endpoint, f"/{INDEX_NAME}/_doc/{DOCUMENT_ID}", None, creds, region
    )
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
