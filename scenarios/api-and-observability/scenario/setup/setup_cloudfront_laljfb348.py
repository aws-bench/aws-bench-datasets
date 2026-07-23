"""
Setup script for stack cloudfront-laljfb348 (api-and-observability).
Seeds S3 tenant keyspaces with content so that tenants appear provisioned.
The CloudFront distribution returns 403 for all tenant requests because the
bucket policy is missing the OAC grant — this is the intentional misconfiguration.
"""

from typing import Optional

import boto3
import sys
from botocore.config import Config

config = Config(connect_timeout=5, read_timeout=60)

REGION = "us-east-1"
STACK_NAME = "api-and-observability-cloudfront-laljfb348-us-east-1"

TENANTS = ["onyx-test", "demo-tenant"]

INDEX_HTML = b"""<!DOCTYPE html>
<html><head><title>Tenant Application</title></head>
<body><h1>Welcome</h1><script src="app.js"></script></body>
</html>"""

APP_JS = b'console.log("Tenant application loaded");'


def run(session: Optional[boto3.Session] = None, region: str = REGION, **parameters):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY")

    cfn = session.client("cloudformation", config=config, region_name=region)
    outputs = {
        o["OutputKey"]: o["OutputValue"]
        for o in cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]["Outputs"]
    }

    bucket_name = outputs["TenantServicesBucketName"]
    s3 = session.client("s3", config=config, region_name=region)

    for tenant_id in TENANTS:
        s3.put_object(
            Bucket=bucket_name,
            Key=f"{tenant_id}/index.html",
            Body=INDEX_HTML,
            ContentType="text/html",
        )
        s3.put_object(
            Bucket=bucket_name,
            Key=f"{tenant_id}/app.js",
            Body=APP_JS,
            ContentType="application/javascript",
        )
        print(f"Seeded S3 content for tenant: {tenant_id}")

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
