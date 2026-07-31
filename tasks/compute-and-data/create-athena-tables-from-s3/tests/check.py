"""Programmatic verifier for create-athena-tables-from-s3."""

import json
import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from rewardkit import criterion

REGION = os.environ.get("AWS_REGION", "us-east-1")
CSV_BUCKET = os.environ.get("CSV_BUCKET", "")

AGENT_OUTPUT_PATH = Path("/logs/agent/agent-output.json")
AGENT_OUTPUT: dict = {}
if AGENT_OUTPUT_PATH.exists():
    try:
        AGENT_OUTPUT = json.loads(AGENT_OUTPUT_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        pass

DB_LIST = AGENT_OUTPUT.get("database_name_list", [])


@criterion(description="Agent wrote output.json with database_name_list as a list")
def output_contract(workspace: Path) -> bool:
    return isinstance(DB_LIST, list) and len(DB_LIST) > 0


@criterion(description="All databases exist in Athena")
def databases_exist(workspace: Path) -> bool:
    if not DB_LIST:
        return False
    try:
        client = boto3.client("athena", region_name=REGION)
        glue = boto3.client("glue", region_name=REGION)
        for db_name in DB_LIST:
            glue.get_database(Name=db_name)
        return True
    except ClientError:
        return False


@criterion(description="Each database has at least one table defined")
def tables_have_data(workspace: Path) -> bool:
    if not DB_LIST:
        return False
    try:
        glue = boto3.client("glue", region_name=REGION)
        for db_name in DB_LIST:
            resp = glue.get_tables(DatabaseName=db_name)
            if not resp.get("TableList"):
                return False
        return True
    except ClientError:
        return False
