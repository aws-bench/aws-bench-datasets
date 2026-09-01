"""
Setup script for stack ApiGateway-6b015c55c (api-and-observability).
Seeds the DynamoDB agreements table with a single data usage agreement record.
"""

import json
import sys
from typing import Optional

import boto3
from botocore.config import Config

config = Config(connect_timeout=5, read_timeout=60)

REGION = "us-east-1"
STACK_NAME = "api-and-observability-ApiGateway-6b015c55c-us-east-1"

AGREEMENT = {
    "agreementId": "dua-2024-001",
    "name": "Benchmark Data Usage Agreement",
    "type": "DataUsageAgreement",
    "scope": "Global",
    "jsonSchema": json.dumps(
        {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {
                "dataConsumerId": {
                    "type": "string",
                    "description": "Unique identifier for the data consumer",
                },
                "datasetId": {
                    "type": "string",
                    "description": "Identifier for the dataset being accessed",
                },
                "purpose": {
                    "type": "string",
                    "enum": ["analytics", "machine-learning", "reporting", "research"],
                    "description": "Intended use of the data",
                },
                "retentionPeriodDays": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 365,
                    "description": "Number of days data can be retained",
                },
                "allowedRegions": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "AWS regions where data processing is permitted",
                },
                "encryptionRequired": {
                    "type": "boolean",
                    "description": "Whether encryption at rest is mandatory",
                },
            },
            "required": [
                "dataConsumerId",
                "datasetId",
                "purpose",
                "retentionPeriodDays",
            ],
        }
    ),
    "agenticContext": {
        "riskAnalysisContextText": (
            "This agreement governs access to sensitive marketplace transaction data. "
            "Key risk factors to evaluate: (1) Data retention period should not exceed "
            "90 days for PII-containing datasets, (2) Cross-region data transfer requires "
            "additional compliance review, (3) Machine learning purposes require explicit "
            "model governance attestation, (4) Encryption must be enabled for all datasets "
            "classified as confidential or higher."
        )
    },
    "version": "1.2.0",
    "effectiveDate": "2024-01-15T00:00:00Z",
    "expirationDate": "2025-12-31T23:59:59Z",
}


def run(session: Optional[boto3.Session] = None, region: str = REGION, **parameters):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY")

    cfn = session.client("cloudformation", config=config, region_name=region)
    outputs = {
        o["OutputKey"]: o["OutputValue"]
        for o in cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]["Outputs"]
    }

    table_name = outputs["TableName"]
    table = session.resource("dynamodb", region_name=region).Table(table_name)

    # put_item is idempotent for the same primary key
    table.put_item(Item=AGREEMENT)
    print(f"Seeded agreement: {AGREEMENT['agreementId']}")

    return {"success": True, "output_values": None}


if __name__ == "__main__":
    try:
        result = run()
        print(result)
        if isinstance(result, dict) and not result.get("success", True):
            sys.exit(1)
    except Exception as e:
        print(f"Setup failed: {e}", file=sys.stderr)
        sys.exit(1)
