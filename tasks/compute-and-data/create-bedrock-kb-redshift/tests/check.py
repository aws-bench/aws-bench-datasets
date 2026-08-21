"""Programmatic verifier for create-bedrock-kb-redshift."""

import json
import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
REDSHIFT_DB = os.environ.get("REDSHIFT_DB", "")

AGENT_OUTPUT_PATH = Path("/logs/agent/agent-output.json")
AGENT_OUTPUT: dict = {}
if AGENT_OUTPUT_PATH.exists():
    try:
        AGENT_OUTPUT = json.loads(AGENT_OUTPUT_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        pass

KB_ID = AGENT_OUTPUT.get("knowledge_base_id", "")


@criterion(description="Agent wrote output.json with knowledge_base_id")
def output_contract(workspace: Path) -> bool:
    return bool(KB_ID)


@criterion(description="Knowledge base exists in Bedrock")
def kb_exists(workspace: Path) -> bool:
    try:
        client = boto3.client("bedrock-agent", region_name=REGION)
        resp = client.get_knowledge_base(knowledgeBaseId=KB_ID)
        return resp["knowledgeBase"]["knowledgeBaseId"] == KB_ID
    except ClientError:
        return False


@criterion(description="Knowledge base has a Redshift data source")
def kb_has_redshift_source(workspace: Path) -> bool:
    try:
        client = boto3.client("bedrock-agent", region_name=REGION)
        resp = client.list_data_sources(knowledgeBaseId=KB_ID)
        for ds in resp.get("dataSourceSummaries", []):
            ds_detail = client.get_data_source(
                knowledgeBaseId=KB_ID, dataSourceId=ds["dataSourceId"]
            )
            ds_type = (
                ds_detail["dataSource"]
                .get("dataSourceConfiguration", {})
                .get("type", "")
            )
            if "REDSHIFT" in ds_type.upper():
                return True
        return False
    except ClientError:
        return False
