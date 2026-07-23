"""
Pre-invoke script for stack WebSocket-d761a646a (api-and-observability)

What this does:
  Runs the agent script briefly (15s) to generate fresh CloudWatch Logs
  showing the WebSocket connection issues before each agent probe.

Prerequisites:
  - Stack must be deployed and setup script must have been run first
  - AWS credentials must be active for the target account
  - websocat must be installed:
    curl -sL https://github.com/vi/websocat/releases/download/v1.13.0/websocat.x86_64-unknown-linux-musl -o /usr/local/bin/websocat && chmod +x /usr/local/bin/websocat

Stack outputs used:
  WebSocketEndpoint, AgentScriptsBucketName
    from api-and-observability-WebSocket-d761a646a-us-east-1
"""

import json
import logging
import os
import subprocess
import sys
import tempfile
import time
from typing import Any, Dict, Optional

import boto3
from botocore.config import Config

logger = logging.getLogger(__name__)
config = Config(connect_timeout=5, read_timeout=60)


REGION = "us-east-1"
STACK_NAME = "api-and-observability-WebSocket-d761a646a-us-east-1"


def _has_websocat() -> bool:
    try:
        subprocess.run(["which", "websocat"], check=True, capture_output=True)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


def _run_agent(
    s3, bucket_name: str, websocket_endpoint: str, duration: int = 15
) -> None:
    """Download agent script from S3, inject endpoint, run for duration seconds."""
    response = s3.get_object(Bucket=bucket_name, Key="flint-agent.sh")
    script = response["Body"].read().decode("utf-8")
    script = script.replace("PLACEHOLDER_WEBSOCKET_ENDPOINT", websocket_endpoint)

    with tempfile.NamedTemporaryFile(mode="w", suffix=".sh", delete=False) as f:
        f.write(script)
        script_path = f.name

    os.chmod(script_path, 0o755)

    try:
        logger.info(f"Running agent for {duration}s to generate fresh logs...")
        process = subprocess.Popen(
            [script_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        time.sleep(duration)
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
        logger.info("Agent execution completed")
    finally:
        os.unlink(script_path)


RESULT_FILE = "/logs/pre_invoke/placeholder.json"


def run(
    session: Optional[boto3.Session] = None,
    region: str = REGION,
    **parameters,
):
    if session is None:
        session = boto3.Session(region_name=region)

    cfn = session.client("cloudformation", config=config, region_name=region)
    s3 = session.client("s3", config=config, region_name=region)

    outputs = {
        o["OutputKey"]: o["OutputValue"]
        for o in cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]["Outputs"]
    }

    websocket_endpoint = outputs["WebSocketEndpoint"]
    bucket_name = outputs["AgentScriptsBucketName"]

    if not _has_websocat():
        logger.error("websocat not installed — cannot generate fresh logs")
        raise RuntimeError("pre_invoke failed")

    _run_agent(s3, bucket_name, websocket_endpoint, duration=15)

    logger.info("Waiting 5s for logs to propagate...")
    time.sleep(5)

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
