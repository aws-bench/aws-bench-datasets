"""
Pre-invoke script for test case 4dd76340-9f4d-4fdb-9f6f-800ddec2fed2.

Clears existing log streams and seeds fresh AgentCore runtime log events
into the basalt_agent_mcp log group with recent timestamps so the logs
look like they came from a runtime that was active shortly before.
"""

import json
import os
import logging
import sys
import time
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional


import boto3
from botocore.config import Config

logger = logging.getLogger(__name__)
config = Config(connect_timeout=5, read_timeout=60)

REGION = "us-west-2"

# Log group names matching what the AgentCore service would create.
# These are NOT managed by CloudFormation — the pre-invoke script creates
# them directly so they appear as orphaned service-created log groups.
RUNTIME_LOG_GROUP = (
    "/aws/bedrock-agentcore/runtimes/basalt_agent_mcp-kR7vPq2wXn-DEFAULT"
)
APPLICATION_LOGS_GROUP = "/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/basalt_agent_mcp-kR7vPq2wXn"
USAGE_LOGS_GROUP = (
    "/aws/vendedlogs/bedrock-agentcore/runtime/USAGE_LOGS/basalt_agent_mcp-kR7vPq2wXn"
)


def _ts_fmt(epoch_ms):
    return (
        datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%S.%f"
        )[:-3]
        + "Z"
    )


def _ensure_log_group(logs, name, retention_days=7):
    try:
        logs.create_log_group(logGroupName=name)
        logs.put_retention_policy(logGroupName=name, retentionInDays=retention_days)
        logger.info(f"Created log group {name}")
    except logs.exceptions.ResourceAlreadyExistsException:
        logger.info(f"Log group {name} already exists")


def _delete_all_streams(logs, log_group_name):
    paginator = logs.get_paginator("describe_log_streams")
    for page in paginator.paginate(logGroupName=log_group_name):
        for stream in page.get("logStreams", []):
            logs.delete_log_stream(
                logGroupName=log_group_name,
                logStreamName=stream["logStreamName"],
            )
    logger.info(f"Cleared all streams from {log_group_name}")


def _build_sessions(base_ts):
    """Build log streams and events with timestamps relative to base_ts (epoch ms)."""
    date_str = datetime.fromtimestamp(base_ts / 1000, tz=timezone.utc).strftime(
        "%Y/%m/%d"
    )
    sessions = []

    # Session 1: successful invocation
    sid1 = str(uuid.uuid4())
    rid1 = str(uuid.uuid4())
    t = base_ts
    sessions.append(
        {
            "stream": f"{date_str}/[runtime-logs-{sid1}]{uuid.uuid4()}",
            "events": [
                (t, "WARNING:  Invalid HTTP request received."),
                (
                    t + 1800,
                    json.dumps(
                        {
                            "timestamp": _ts_fmt(t + 1800),
                            "level": "INFO",
                            "message": "Processing invocation request",
                            "logger": "bedrock_agentcore.app",
                            "requestId": rid1,
                            "sessionId": sid1,
                        }
                    ),
                ),
                (
                    t + 3500,
                    json.dumps(
                        {
                            "timestamp": _ts_fmt(t + 3500),
                            "level": "INFO",
                            "message": "Invocation completed successfully (1.700s)",
                            "logger": "bedrock_agentcore.app",
                            "requestId": rid1,
                            "sessionId": sid1,
                        }
                    ),
                ),
            ],
        }
    )

    # Session 2: successful invocation
    sid2 = str(uuid.uuid4())
    rid2 = str(uuid.uuid4())
    t = base_ts + 30000
    sessions.append(
        {
            "stream": f"{date_str}/[runtime-logs-{sid2}]{uuid.uuid4()}",
            "events": [
                (t, "WARNING:  Invalid HTTP request received."),
                (
                    t + 2100,
                    json.dumps(
                        {
                            "timestamp": _ts_fmt(t + 2100),
                            "level": "INFO",
                            "message": "Processing invocation request",
                            "logger": "bedrock_agentcore.app",
                            "requestId": rid2,
                            "sessionId": sid2,
                        }
                    ),
                ),
                (
                    t + 4800,
                    json.dumps(
                        {
                            "timestamp": _ts_fmt(t + 4800),
                            "level": "INFO",
                            "message": "Invocation completed successfully (2.700s)",
                            "logger": "bedrock_agentcore.app",
                            "requestId": rid2,
                            "sessionId": sid2,
                        }
                    ),
                ),
            ],
        }
    )

    # Session 3: ModuleNotFoundError (aiohttp)
    sid3 = str(uuid.uuid4())
    t = base_ts + 120000
    sessions.append(
        {
            "stream": f"{date_str}/[runtime-logs-mcp-test-{sid3}]{uuid.uuid4()}",
            "events": [
                (t, "Traceback (most recent call last):"),
                (t + 1, '  File "/var/task/main.py", line 4, in <module>'),
                (t + 2, "    import aiohttp"),
                (t + 3, "ModuleNotFoundError: No module named 'aiohttp'"),
            ],
        }
    )

    # Session 4: invalid JSON warning
    sid4 = str(uuid.uuid4())
    rid4 = str(uuid.uuid4())
    t = base_ts + 180000
    sessions.append(
        {
            "stream": f"{date_str}/[runtime-logs-{sid4}]{uuid.uuid4()}",
            "events": [
                (t, "WARNING:  Invalid HTTP request received."),
                (
                    t + 1,
                    json.dumps(
                        {
                            "timestamp": _ts_fmt(t + 1),
                            "level": "WARNING",
                            "message": "Invalid JSON in request (0.000s): Expecting value: line 1 column 1 (char 0)",
                            "logger": "bedrock_agentcore.app",
                            "requestId": rid4,
                            "sessionId": sid4,
                        }
                    ),
                ),
            ],
        }
    )

    # Session 5: ModuleNotFoundError (requests)
    sid5 = str(uuid.uuid4())
    t = base_ts + 300000
    sessions.append(
        {
            "stream": f"{date_str}/[runtime-logs-test-{sid5}]{uuid.uuid4()}",
            "events": [
                (t, "Traceback (most recent call last):"),
                (t + 1, '  File "/var/task/main.py", line 3, in <module>'),
                (t + 2, "    import requests"),
                (t + 3, "ModuleNotFoundError: No module named 'requests'"),
            ],
        }
    )

    return sessions


RESULT_FILE = "/logs/pre_invoke/placeholder.json"


def run(
    session: Optional[boto3.Session] = None,
    region: str = REGION,
    **parameters,
):
    if session is None:
        session = boto3.Session(region_name=region)

    logs_client = session.client("logs", config=config, region_name=region)

    # Ensure all three basalt_agent_mcp log groups exist (not managed by CDK)
    _ensure_log_group(logs_client, RUNTIME_LOG_GROUP)
    _ensure_log_group(logs_client, APPLICATION_LOGS_GROUP)
    _ensure_log_group(logs_client, USAGE_LOGS_GROUP)

    # Clear existing streams from the runtime log group
    _delete_all_streams(logs_client, RUNTIME_LOG_GROUP)

    # Seed with timestamps from ~2 hours ago
    base_ts = int((datetime.now(timezone.utc) - timedelta(hours=2)).timestamp() * 1000)
    sessions = _build_sessions(base_ts)

    for s in sessions:
        logs_client.create_log_stream(
            logGroupName=RUNTIME_LOG_GROUP, logStreamName=s["stream"]
        )
        logs_client.put_log_events(
            logGroupName=RUNTIME_LOG_GROUP,
            logStreamName=s["stream"],
            logEvents=[{"timestamp": ts, "message": msg} for ts, msg in s["events"]],
        )
        logger.info(f"Seeded stream {s['stream']} with {len(s['events'])} events")
        time.sleep(0.1)

    logger.info(f"Seeded {len(sessions)} streams into {RUNTIME_LOG_GROUP}")
    return


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    try:
        run()
    except Exception as e:
        print(f"pre_invoke failed: {e}", file=sys.stderr)
        sys.exit(1)
    os.makedirs(os.path.dirname(RESULT_FILE), exist_ok=True)
    with open(RESULT_FILE, "w") as f:
        json.dump({}, f)
