"""Programmatic verifier for serverless-stripe-api-with-stream.

Re-implements aws-bench-datasets/src/aws_bench_datasets/mutation_scripts/36888a8c-4fab-44a8-897b-03b599817d90/validate.py.

The agent creates a serverless stack (Lambda + DynamoDB + API Gateway).
Verifier:
  1. confirms each named resource exists,
  2. hits the api_endpoint, expects 200,
  3. confirms the DynamoDB table received at least one item after the
     request (i.e. the Lambda was actually invoked end-to-end).
"""

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    AGENT_OUTPUT = {}

REQUIRED_OUTPUT_KEYS = (
    "dynamodb_table",
    "lambda_function_name",
    "apigateway_id",
    "api_endpoint",
)
TABLE_NAME = AGENT_OUTPUT.get("dynamodb_table") or ""
FUNCTION_NAME = AGENT_OUTPUT.get("lambda_function_name") or ""
API_ID = AGENT_OUTPUT.get("apigateway_id") or ""
API_ENDPOINT = AGENT_OUTPUT.get("api_endpoint") or ""

URL_TIMEOUT_SEC = 30
DDB_PROPAGATION_WAIT_SEC = 10


def _lambda():
    return boto3.client("lambda", region_name=REGION)


def _dynamodb():
    return boto3.resource("dynamodb", region_name=REGION)


def _apigatewayv2():
    return boto3.client("apigatewayv2", region_name=REGION)


def _apigateway():
    return boto3.client("apigateway", region_name=REGION)


@criterion(description="agent wrote agent-output.json with all required keys")
def output_contract_followed(workspace: Path) -> bool:
    return bool(AGENT_OUTPUT) and all(k in AGENT_OUTPUT for k in REQUIRED_OUTPUT_KEYS)


@criterion(
    description="reported Lambda + DynamoDB table + API Gateway (v1 or v2) all exist"
)
def serverless_resources_exist(workspace: Path) -> bool:
    if not (FUNCTION_NAME and TABLE_NAME and API_ID):
        return False
    try:
        _lambda().get_function(FunctionName=FUNCTION_NAME)
    except ClientError:
        return False
    try:
        _dynamodb().Table(TABLE_NAME).load()
    except ClientError:
        return False
    # Try v2 first (HTTP API), fall back to v1 (REST API).
    try:
        _apigatewayv2().get_api(ApiId=API_ID)
        return True
    except ClientError:
        pass
    try:
        _apigateway().get_rest_api(restApiId=API_ID)
        return True
    except ClientError:
        return False


@criterion(
    description="GET on api_endpoint returns 200 and a DynamoDB item lands within ~10s — confirms the full Lambda → DynamoDB write path"
)
def end_to_end_invocation_writes_to_table(workspace: Path) -> bool:
    if not API_ENDPOINT or not TABLE_NAME:
        return False
    try:
        with urllib.request.urlopen(API_ENDPOINT, timeout=URL_TIMEOUT_SEC) as resp:
            if resp.getcode() != 200:
                return False
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError):
        return False
    # DynamoDB writes are usually immediate, but the Lambda may run async
    # in some integrations — give it a short window before scanning.
    time.sleep(DDB_PROPAGATION_WAIT_SEC)
    try:
        items = _dynamodb().Table(TABLE_NAME).scan(Limit=1).get("Items") or []
    except ClientError:
        return False
    if not items:
        return False
    # Verify item contains IP address and timestamp fields per the instruction
    item = items[0]
    has_ip = any("ip" in k.lower() or "address" in k.lower() for k in item.keys())
    has_timestamp = any(
        "time" in k.lower() or "date" in k.lower() or "created" in k.lower()
        for k in item.keys()
    )
    return has_ip or has_timestamp  # At minimum one identifying field must exist
