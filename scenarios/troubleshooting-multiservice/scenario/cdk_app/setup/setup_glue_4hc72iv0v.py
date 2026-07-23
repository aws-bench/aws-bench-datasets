"""
Setup script for stack glue-4hc72iv0v (troubleshooting-multiservice).
1. Revokes IAMAllowedPrincipals on the database and table to activate LF governance.
2. Triggers a Glue job run and waits for it to fail with a Lake Formation error.

Note: Lake Formation data lake admin and default permissions are configured
by the CDK stack (CfnDataLakeSettings) before the database/table are created.
"""

import boto3
import re
import sys
import time
from botocore.config import Config
from botocore.exceptions import ClientError

LF_ERROR_PATTERN = re.compile(r"lake ?formation", re.IGNORECASE)

config = Config(connect_timeout=5, read_timeout=60)
STACK_NAME = "troubleshooting-multiservice-glue-4hc72iv0v-us-east-1"
REGION = "us-east-1"


def _ensure_lf_governance(lf):
    """Ensure LF defaults are cleared (CDK CfnDataLakeSettings may not clear them)."""
    settings = lf.get_data_lake_settings()["DataLakeSettings"]
    changed = False
    for key in ("CreateDatabaseDefaultPermissions", "CreateTableDefaultPermissions"):
        if settings.get(key):
            settings[key] = []
            changed = True
    if changed:
        lf.put_data_lake_settings(DataLakeSettings=settings)
        print("Cleared Lake Formation default permissions.")
    else:
        print("Lake Formation default permissions already empty.")


def _revoke_iam_allowed_principals(lf, db_name, table_name):
    """Ensure IAMAllowedPrincipals is revoked on the database and table.

    On fresh accounts where defaults were cleared before table creation,
    IAMAllowedPrincipals may never have been granted. We grant then revoke
    to explicitly put the resources under LF governance.
    """
    targets = [
        ({"Database": {"Name": db_name}}, f"database {db_name}"),
        (
            {"Table": {"DatabaseName": db_name, "Name": table_name}},
            f"table {table_name}",
        ),
    ]
    for resource, desc in targets:
        # Grant IAMAllowedPrincipals first to ensure there's something to revoke.
        # AlreadyExistsException means it was already granted — fine, we'll revoke next.
        try:
            lf.grant_permissions(
                Principal={"DataLakePrincipalIdentifier": "IAM_ALLOWED_PRINCIPALS"},
                Resource=resource,
                Permissions=["ALL"],
                PermissionsWithGrantOption=[],
            )
        except ClientError as e:
            code = e.response["Error"]["Code"]
            if code != "AlreadyExistsException":
                print(
                    f"grant_permissions on {desc} failed unexpectedly ({code}); "
                    f"continuing to revoke step."
                )
        # Now revoke it to activate LF governance.
        # EntityNotFoundException means the grant doesn't exist — already revoked.
        try:
            lf.revoke_permissions(
                Principal={"DataLakePrincipalIdentifier": "IAM_ALLOWED_PRINCIPALS"},
                Resource=resource,
                Permissions=["ALL"],
                PermissionsWithGrantOption=[],
            )
            print(f"Revoked IAMAllowedPrincipals on {desc}.")
        except ClientError as e:
            code = e.response["Error"]["Code"]
            if code == "EntityNotFoundException":
                print(f"IAMAllowedPrincipals not granted on {desc} (already revoked).")
            else:
                raise


def run(session: boto3.Session = None, region: str = REGION, **parameters):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY", region_name=region)

    lf = session.client("lakeformation", config=config, region_name=region)
    cfn = session.client("cloudformation", config=config, region_name=region)

    outputs = {
        o["OutputKey"]: o["OutputValue"]
        for o in cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]["Outputs"]
    }
    db_name = outputs["GlueDatabaseName"]
    table_name = outputs["GlueTableName"]
    glue_job_name = outputs["GlueJobName"]

    _ensure_lf_governance(lf)
    _revoke_iam_allowed_principals(lf, db_name, table_name)

    # Idempotent: if a failed run with the expected LF error already exists, skip
    glue = session.client("glue", config=config, region_name=region)
    runs = glue.get_job_runs(JobName=glue_job_name, MaxResults=1).get("JobRuns", [])
    if runs and runs[0]["JobRunState"] == "FAILED":
        error = runs[0].get("ErrorMessage", "")
        if LF_ERROR_PATTERN.search(error):
            print(f"LF-error run already exists: {runs[0]['Id']}")
            return {
                "job_run_id": runs[0]["Id"],
                "final_status": "FAILED",
                "error": error,
            }

    # Trigger job run
    run_id = glue.start_job_run(JobName=glue_job_name)["JobRunId"]
    print(f"Started Glue job run: {run_id}")

    for _ in range(60):
        jr = glue.get_job_run(JobName=glue_job_name, RunId=run_id)["JobRun"]
        status = jr["JobRunState"]
        if status not in ("STARTING", "RUNNING", "STOPPING"):
            break
        time.sleep(10)

    if status != "FAILED":
        raise RuntimeError(f"Expected job to FAIL, got: {status}")
    error = jr.get("ErrorMessage", "")
    if not LF_ERROR_PATTERN.search(error):
        raise RuntimeError(f"Expected Lake Formation error, got: {error}")

    print("Job failed with expected LF error.")
    return {"job_run_id": run_id, "final_status": status, "error": error}


if __name__ == "__main__":
    try:
        result = run()
        print(result)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
