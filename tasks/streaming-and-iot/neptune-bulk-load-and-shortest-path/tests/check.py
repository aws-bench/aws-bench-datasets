"""Programmatic verifier for neptune-bulk-load-and-shortest-path.

Validates the agent bulk-loaded the seeded graph from S3 into Neptune
and computed the correct shortest path. Verification piggybacks on the
in-VPC bridge Lambda since the verifier runs OUTSIDE the cluster's VPC
and cannot reach Neptune's data API directly.

Bridge Lambda dispatches on `action`:
  - loader_status, load_id  -> GetLoaderJobStatus
  - vertex_count            -> g.V().count()
  - edge_count              -> g.E().count()
  - shortest_path, from, to -> g.V().has(...).repeat(both().simplePath()).until(...)
"""

import json
import os
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from rewardkit import criterion

# Lambda's cold-start ENI in a private VPC takes 30-90s; subsequent
# invocations are <2s. We extend the boto3 read_timeout to 5 minutes
# (the bridge Lambda's own timeout). 6-min total to leave handler
# margin.
_BRIDGE_INVOKE_CONFIG = Config(read_timeout=360, retries={"max_attempts": 1})

REGION = os.environ.get("AWS_REGION", "us-east-1")
BRIDGE_LAMBDA_NAME = os.environ.get("BRIDGE_LAMBDA_NAME", "")

EXPECTED_VERTEX_COUNT = 5
EXPECTED_EDGE_COUNT = 6
SHORTEST_PATH_FROM = "alice"
SHORTEST_PATH_TO = "eve"

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    AGENT_OUTPUT = {}

REQUIRED_OUTPUT_KEYS = ("load_id", "path_length")
CHOSEN_LOAD_ID = AGENT_OUTPUT.get("load_id") or ""
CHOSEN_PATH_LENGTH = AGENT_OUTPUT.get("path_length")


def _invoke_bridge(payload: dict) -> dict | None:
    """Synchronously invoke the bridge Lambda. Returns the parsed
    response payload, or None on transport failure. The bridge wraps its
    own exceptions in {ok: False, error: ...} so most failures land here
    as a structured response rather than an exception.
    """
    if not BRIDGE_LAMBDA_NAME:
        return None
    try:
        client = boto3.client(
            "lambda", region_name=REGION, config=_BRIDGE_INVOKE_CONFIG
        )
        resp = client.invoke(
            FunctionName=BRIDGE_LAMBDA_NAME,
            InvocationType="RequestResponse",
            Payload=json.dumps(payload).encode("utf-8"),
        )
    except ClientError:
        return None
    except Exception:  # noqa: BLE001 -- also catch ReadTimeoutError
        return None
    raw = resp.get("Payload")
    if raw is None:
        return None
    try:
        return json.loads(raw.read())
    except (json.JSONDecodeError, AttributeError):
        return None


@criterion(description="agent wrote agent-output.json with all required keys")
def output_contract_followed(workspace: Path) -> bool:
    return bool(AGENT_OUTPUT) and all(k in AGENT_OUTPUT for k in REQUIRED_OUTPUT_KEYS)


@criterion(
    description="bulk-load job referenced by agent's load_id reached LOAD_COMPLETED"
)
def loader_completed(workspace: Path) -> bool:
    if not CHOSEN_LOAD_ID:
        return False
    resp = _invoke_bridge({"action": "loader_status", "load_id": CHOSEN_LOAD_ID})
    if not resp or not resp.get("ok"):
        return False
    # GetLoaderJobStatus returns nested under result.payload.overallStatus.status
    payload = (resp.get("result") or {}).get("payload") or {}
    overall = payload.get("overallStatus") or {}
    return overall.get("status") == "LOAD_COMPLETED"


@criterion(
    description=f"vertex_count via bridge equals {EXPECTED_VERTEX_COUNT} (seeded users)"
)
def vertex_count_correct(workspace: Path) -> bool:
    resp = _invoke_bridge({"action": "vertex_count"})
    if not resp or not resp.get("ok"):
        return False
    return resp.get("count") == EXPECTED_VERTEX_COUNT


@criterion(
    description=f"edge_count via bridge equals {EXPECTED_EDGE_COUNT} (seeded friendships)"
)
def edge_count_correct(workspace: Path) -> bool:
    resp = _invoke_bridge({"action": "edge_count"})
    if not resp or not resp.get("ok"):
        return False
    return resp.get("count") == EXPECTED_EDGE_COUNT


@criterion(
    description=f"agent's reported path_length matches shortest path {SHORTEST_PATH_FROM}->{SHORTEST_PATH_TO}"
)
def path_length_matches_truth(workspace: Path) -> bool:
    if CHOSEN_PATH_LENGTH is None:
        return False
    resp = _invoke_bridge(
        {
            "action": "shortest_path",
            "from": SHORTEST_PATH_FROM,
            "to": SHORTEST_PATH_TO,
        }
    )
    if not resp or not resp.get("ok"):
        return False
    truth = resp.get("path_length")
    if truth is None:
        return False
    try:
        return int(CHOSEN_PATH_LENGTH) == int(truth)
    except (TypeError, ValueError):
        return False
