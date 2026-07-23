"""
Setup script for stack cloudfront-e0239752d (api-and-observability).
Seeds the DynamoDB tenants table with tenant records and triggers Step Functions
provisioning workflows, waiting for them to complete.
"""

import json
import sys
import time
from datetime import datetime
from typing import Optional

import boto3
from botocore.config import Config

config = Config(connect_timeout=5, read_timeout=60)

REGION = "us-east-1"
STACK_NAME = "api-and-observability-cloudfront-e0239752d-us-east-1"

TENANTS = [
    {"tenant_id": "basalt-tenant", "email": "basalt@example.com"},
    {"tenant_id": "onyx-test", "email": "onyx@example.com"},
]


def run(session: Optional[boto3.Session] = None, region: str = REGION, **parameters):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY")

    cfn = session.client("cloudformation", config=config, region_name=region)
    sfn = session.client("stepfunctions", config=config, region_name=region)

    outputs = {
        o["OutputKey"]: o["OutputValue"]
        for o in cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]["Outputs"]
    }
    table_name = outputs["TenantsTableName"]
    state_machine_arn = outputs["TenantProvisioningWorkflowArn"]

    table = session.resource("dynamodb", region_name=region).Table(table_name)

    for t in TENANTS:
        table.put_item(
            Item={
                "tenant_id": t["tenant_id"],
                "owner_user_id": "synthetic-user-id",
                "email": t["email"],
                "status": "PENDING",
                "created_at": datetime.utcnow().isoformat(),
            }
        )
        print(f"Seeded {t['tenant_id']} (PENDING)")

    execution_arns = {}
    for t in TENANTS:
        tid = t["tenant_id"]
        # Use a deterministic execution name so re-runs detect the existing execution
        exec_name = f"{tid}-setup"
        try:
            resp = sfn.start_execution(
                stateMachineArn=state_machine_arn,
                name=exec_name,
                input=json.dumps({"tenant_id": tid}),
            )
            execution_arns[tid] = resp["executionArn"]
            print(f"Started workflow for {tid}")
        except sfn.exceptions.ExecutionAlreadyExists:
            # Execution already ran; find its ARN from list
            executions = sfn.list_executions(
                stateMachineArn=state_machine_arn, statusFilter="SUCCEEDED"
            )
            for ex in executions["executions"]:
                if ex["name"] == exec_name:
                    print(f"Workflow for {tid} already succeeded, skipping")
                    break
            else:
                # Still running or failed — include in wait set
                executions_all = sfn.list_executions(stateMachineArn=state_machine_arn)
                for ex in executions_all["executions"]:
                    if ex["name"] == exec_name:
                        execution_arns[tid] = ex["executionArn"]
                        break

    deadline = time.time() + 120
    pending = set(execution_arns)
    while pending and time.time() < deadline:
        time.sleep(5)
        for tid in list(pending):
            status = sfn.describe_execution(executionArn=execution_arns[tid])["status"]
            if status in ("SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"):
                print(f"{tid}: {status}")
                if status != "SUCCEEDED":
                    raise RuntimeError(f"Workflow for {tid} ended with {status}")
                pending.discard(tid)

    if pending:
        raise RuntimeError(f"Workflows timed out: {pending}")

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
