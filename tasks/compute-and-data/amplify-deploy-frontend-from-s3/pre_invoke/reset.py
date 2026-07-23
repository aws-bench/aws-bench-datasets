"""Data-plane reset for amplify-deploy-frontend-from-s3.

Deletes the agent-created Amplify apps, empties the frontend source bucket and
re-puts the seed objects, and reverts the agent's bucket-policy change. Imported
and called first by both pre_invoke and post_invoke; config from env.
Best-effort: returns a list of error strings rather than raising.
"""

import json
import mimetypes
import os

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
BUCKET_NAME = os.environ.get("AMPLIFY_DATA_BUCKET", "")

# index.html references assets/main.css and build/app.bundle.js, but those
# files are seeded under styles/ and scripts/. This misalignment is the task's
# starting condition.
# key -> object body; the leading newline is part of the seed.
OBJECTS: dict[str, str] = {
    "src/index.html": """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>React App</title>
    <link rel="stylesheet" href="assets/main.css">
</head>
<body>
    <div id="root"></div>
    <script src="build/app.bundle.js"></script>
</body>
</html>""",
    "styles/main.css": """
body { font-family: Arial, sans-serif; margin: 0; padding: 20px; }
.container { max-width: 800px; margin: 0 auto; }
h1 { color: #333; }""",
    "scripts/app.js": """
console.log('React App Loaded');
document.getElementById('root').innerHTML = '<h1>Hello React!</h1>';""",
}


def _empty(s3, bucket: str, errors: list[str]) -> None:
    """Delete every object version + delete marker (the bucket is versioned)."""
    try:
        paginator = s3.get_paginator("list_object_versions")
        for page in paginator.paginate(Bucket=bucket):
            to_delete = [
                {"Key": v["Key"], "VersionId": v["VersionId"]}
                for v in (page.get("Versions", []) + page.get("DeleteMarkers", []))
            ]
            if to_delete:
                s3.delete_objects(Bucket=bucket, Delete={"Objects": to_delete})
    except ClientError as e:
        errors.append(f"empty {bucket}: {e}")


def _put(s3, bucket: str, key: str, body: str, errors: list[str]) -> None:
    # Content-Type from the file extension
    ctype = mimetypes.guess_type(key)[0] or "application/octet-stream"
    try:
        s3.put_object(
            Bucket=bucket, Key=key, Body=body.encode("utf-8"), ContentType=ctype
        )
    except ClientError as e:
        errors.append(f"put {key}: {e}")


def _delete_apps(amplify, errors: list[str]) -> None:
    """Delete every Amplify app in the account (all are agent-created)."""
    try:
        for page in amplify.get_paginator("list_apps").paginate():
            for app in page.get("apps", []):
                try:
                    amplify.delete_app(appId=app["appId"])
                except ClientError as e:
                    errors.append(f"delete_app {app.get('appId')}: {e}")
    except ClientError as e:
        errors.append(f"list_apps: {e}")


def _grants_amplify(statement: dict) -> bool:
    """True if the statement grants access to the Amplify service principal."""
    principal = statement.get("Principal")
    if not isinstance(principal, dict):
        return False
    service = principal.get("Service", [])
    if isinstance(service, str):
        service = [service]
    return any("amplify.amazonaws.com" in s for s in service)


def _revert_bucket_policy(s3, bucket: str, errors: list[str]) -> None:
    """Remove agent-added Amplify grants from the source bucket policy.

    The task requires the agent to grant ``amplify.amazonaws.com`` read access
    to the source bucket, so the agent adds an ``Allow`` statement for that
    service principal. The framework's resource-level reset only deletes *new*
    resources; it does not revert a *modified* property of a baseline
    (CDK-managed) bucket policy, so that statement survives across trials unless
    removed here. Baseline CDK statements (the SecureTransport ``Deny`` and the
    auto-delete role ``Allow``) do not target the Amplify service, so they are
    preserved.
    """
    try:
        current = s3.get_bucket_policy(Bucket=bucket)["Policy"]
    except ClientError as e:
        # No policy at all => nothing to revert.
        if e.response.get("Error", {}).get("Code") == "NoSuchBucketPolicy":
            return
        errors.append(f"get_bucket_policy {bucket}: {e}")
        return

    try:
        policy = json.loads(current)
    except (ValueError, TypeError) as e:
        errors.append(f"parse policy {bucket}: {e}")
        return

    statements = policy.get("Statement", [])
    kept = [s for s in statements if not _grants_amplify(s)]
    if len(kept) == len(statements):
        return  # no agent-added Amplify grant present

    try:
        if kept:
            policy["Statement"] = kept
            s3.put_bucket_policy(Bucket=bucket, Policy=json.dumps(policy))
        else:
            # Every statement was an agent grant — no baseline policy to keep.
            s3.delete_bucket_policy(Bucket=bucket)
    except ClientError as e:
        errors.append(f"revert bucket policy {bucket}: {e}")


def reset_data_plane(
    session: "boto3.Session | None" = None, region: str = REGION
) -> list[str]:
    """Delete agent-created Amplify apps, empty the source bucket, re-put seeds,
    and revert the agent's bucket-policy change.

    Idempotent. Returns a list of error strings (empty on success); never raises
    for a per-object failure.
    """
    if not BUCKET_NAME:
        return []
    if session is None:
        session = boto3.Session(region_name=region)
    s3 = session.client("s3", region_name=region)
    errors: list[str] = []
    _delete_apps(session.client("amplify", region_name=region), errors)
    _empty(s3, BUCKET_NAME, errors)
    for key, body in OBJECTS.items():
        _put(s3, BUCKET_NAME, key, body, errors)
    _revert_bucket_policy(s3, BUCKET_NAME, errors)
    return errors
