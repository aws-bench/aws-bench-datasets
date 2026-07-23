"""Programmatic verifier for amplify-deploy-frontend-from-s3.

Re-implements aws-bench-datasets/src/aws_bench_datasets/mutation_scripts/d6508aa4-93b8-4839-8572-0a8ad1b9337a/validate.py.

The agent picks the Amplify app's URL and reports it via agent-output.json.
Verifier hits the URL, fetches the source `index.html` from the seeded
S3 bucket, and confirms the deployed page either matches exactly or
contains the source content (legacy partial-match behavior).
"""

import json
import os
import urllib.error
import urllib.request
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
BUCKET_NAME = os.environ["EXPECTED_BUCKET"]

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    AGENT_OUTPUT = {}

REQUIRED_OUTPUT_KEYS = ("app_url",)
APP_URL = AGENT_OUTPUT.get("app_url") or ""

URL_TIMEOUT_SEC = 10
# The seeded scenario bucket places the entry HTML at `src/index.html`
# (verified against compute-and-data-s3-s5wscsi4m). The legacy
# validate.py read it from `index.html`, but that key doesn't exist —
# so the legacy verifier never could have passed on a real deployment.
SOURCE_KEY = "src/index.html"


def _fetch_url(url: str) -> tuple[int, str] | None:
    """Return (status, body) or None on any error. Bounded by URL_TIMEOUT_SEC."""
    try:
        with urllib.request.urlopen(url, timeout=URL_TIMEOUT_SEC) as resp:
            return resp.getcode(), resp.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, OSError):
        return None


def _fetch_source() -> str | None:
    """Read the S3 source `index.html` for content comparison. None on missing/error."""
    try:
        body = (
            boto3.client("s3", region_name=REGION)
            .get_object(Bucket=BUCKET_NAME, Key=SOURCE_KEY)["Body"]
            .read()
            .decode("utf-8", errors="replace")
        )
    except ClientError:
        return None
    return body


@criterion(description="agent wrote agent-output.json with all required keys")
def output_contract_followed(workspace: Path) -> bool:
    return bool(AGENT_OUTPUT) and all(k in AGENT_OUTPUT for k in REQUIRED_OUTPUT_KEYS)


@criterion(
    description="reported Amplify app URL serves the S3 index.html content (200 OK; exact or contains-prefix match)"
)
def app_serves_s3_content(workspace: Path) -> bool:
    """Single criterion covers reachability + content check.

    Legacy script accepts both an exact strip-equal match and a
    "deployed page contains the first 100 chars of source" partial
    match — keeps the verifier tolerant of Amplify wrappers/headers
    while still failing on a wrong app.
    """
    if not APP_URL:
        return False
    fetched = _fetch_url(APP_URL)
    if fetched is None or fetched[0] != 200:
        return False
    deployed = fetched[1]
    source = _fetch_source()
    if source is None:
        return False
    if source.strip() == deployed.strip():
        return True
    return source[:100] in deployed
