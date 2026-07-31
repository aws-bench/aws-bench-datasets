"""Programmatic verifier for kinesis-flink-studio-realtime.

Re-implements aws-bench-datasets/src/aws_bench_datasets/mutation_scripts/7f819d03-c6ca-4959-81c5-e4e48482b514/validate.py.

The agent picks the studio notebook's ApplicationName and reports it via
agent-output.json. Verifier calls KinesisAnalyticsV2 DescribeApplication
and confirms the runtime is Flink-based.
"""

import json
import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_REGION", "us-east-1")

try:
    AGENT_OUTPUT = json.loads(Path("/logs/agent/agent-output.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    AGENT_OUTPUT = {}

REQUIRED_OUTPUT_KEYS = ("studio_notebook_application_name",)
APP_NAME = AGENT_OUTPUT.get("studio_notebook_application_name") or ""

# Studio notebooks expose ZEPPELIN-FLINK-* runtimes,
# both indicating a Managed Apache Flink studio. SQL applications
# (SQL-1_0 etc.) do NOT count — they're a separate KDA product.
FLINK_RUNTIME_PREFIXES = (
    "ZEPPELIN-FLINK",
)  # Studio notebooks only — not regular FLINK streaming apps


@criterion(description="agent wrote agent-output.json with all required keys")
def output_contract_followed(workspace: Path) -> bool:
    return bool(AGENT_OUTPUT) and all(k in AGENT_OUTPUT for k in REQUIRED_OUTPUT_KEYS)


@criterion(
    description="reported KDA v2 application exists and runs a Flink studio runtime (ZEPPELIN-FLINK-*)"
)
def studio_notebook_is_flink(workspace: Path) -> bool:
    if not APP_NAME:
        return False
    try:
        resp = boto3.client(
            "kinesisanalyticsv2", region_name=REGION
        ).describe_application(ApplicationName=APP_NAME)
    except ClientError:
        return False
    runtime = (resp.get("ApplicationDetail") or {}).get("RuntimeEnvironment", "")
    return any(runtime.startswith(p) for p in FLINK_RUNTIME_PREFIXES)
