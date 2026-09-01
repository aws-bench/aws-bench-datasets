#!/bin/bash
# Reference solution: repair GitHub Actions OIDC federation for the failing CI repo.
#
# The payments-api runner mints a fresh id_token on every build and stashes it in the
# artifact bucket. No baseline token is pre-seeded: the reference discovery path is
# to trigger a fresh build, list `gha-tokens/`, take the newest object, decode it,
# and use the claims to patch the payments-api statement on the shared deploy role.
# (A parallel path exists via SSM under `/acme/platform/observability/tokens/`, where
# the runner's claim-set template lives among the captured sibling tokens as the
# single non-JWT parameter.)
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
PROJECT="${FAILING_PROJECT_NAME:-payments-api-gha-runner}"

mkdir -p /logs/agent

python3 - "$REGION" "$PROJECT" <<'PY'
import base64
import fnmatch
import json
import re
import sys
import time

import boto3
from botocore.exceptions import ClientError

region, project_name = sys.argv[1], sys.argv[2]
session = boto3.Session(region_name=region)
codebuild = session.client("codebuild")
iam = session.client("iam")
s3 = session.client("s3")
sts = session.client("sts")

account = sts.get_caller_identity()["Account"]
oidc_host = "token.actions.githubusercontent.com"
provider_arn = f"arn:aws:iam::{account}:oidc-provider/{oidc_host}"

# 1. What does the failing runner target?
project = codebuild.batch_get_projects(names=[project_name])["projects"][0]
env = {v["name"]: v["value"] for v in project["environment"].get("environmentVariables", [])}
role_arn = env["DEPLOY_ROLE_ARN"]
role_name = role_arn.split("/")[-1]
bucket = env["ARTIFACT_BUCKET"]
gh_repository = env["GH_REPOSITORY"]  # slug form, e.g. acme-corp/payments-api
print(f"failing runner {project_name} targets role {role_name} for {gh_repository}")


# 2. Trigger a fresh runner build so a non-stale token appears in gha-tokens/.
build_id = codebuild.start_build(projectName=project_name)["build"]["id"]
print(f"started build {build_id}")
deadline = time.time() + 480
final_status = None
while time.time() < deadline:
    resp = codebuild.batch_get_builds(ids=[build_id])["builds"][0]
    status = resp["buildStatus"]
    if status != "IN_PROGRESS":
        final_status = status
        break
    time.sleep(15)
print(f"build finished: {final_status}")

# 3. Find the freshest object under gha-tokens/ and decode it.
def strip_immutable(text: str) -> str:
    return re.sub(r"@\d+", "", text)


def decode_jwt_payload(token: str) -> dict:
    payload_b64 = token.split(".")[1]
    payload_b64 += "=" * (-len(payload_b64) % 4)
    return json.loads(base64.urlsafe_b64decode(payload_b64))


paginator = s3.get_paginator("list_objects_v2")
best = None
for page in paginator.paginate(Bucket=bucket, Prefix="gha-tokens/"):
    for entry in page.get("Contents", []):
        if best is None or entry["LastModified"] > best["LastModified"]:
            best = entry
if best is None:
    raise SystemExit(f"no id_token found under s3://{bucket}/gha-tokens/")
print(f"newest stashed token: s3://{bucket}/{best['Key']} ({best['LastModified']})")

token_body = s3.get_object(Bucket=bucket, Key=best["Key"])["Body"].read().decode()
claims = decode_jwt_payload(token_body)
subject = claims["sub"]
audience = claims["aud"]
repository = claims["repository"]
repository_id = str(claims["repository_id"])
repository_owner_id = str(claims["repository_owner_id"])
print(f"presented sub={subject}")
print(f"presented aud={audience}")
print(f"presented repository_id={repository_id} repository_owner_id={repository_owner_id}")

# 4. Read the live trust policy, identify BOTH faults on the failing statement, patch it.
doc = iam.get_role(RoleName=role_name)["Role"]["AssumeRolePolicyDocument"]
short_slug = gh_repository.split("/")[-1]

faults = []
patched = False
for statement in doc.get("Statement", []):
    principal = statement.get("Principal") or {}
    federated = principal.get("Federated")
    federated_list = federated if isinstance(federated, list) else [federated]
    if provider_arn not in federated_list:
        continue
    condition = statement.get("Condition", {}) or {}
    sub_values = []
    aud_values = []
    for operator, mapping in condition.items():
        for key, value in (mapping or {}).items():
            values = value if isinstance(value, list) else [value]
            if key.lower().endswith(":sub"):
                sub_values.extend(values)
            elif key.lower().endswith(":aud"):
                aud_values.extend(values)
    if not any(short_slug in s for s in sub_values):
        continue

    sub_ok = any(fnmatch.fnmatchcase(subject, pat) for pat in sub_values)
    if not sub_ok:
        faults.append(
            "sub pattern used the slug format "
            f"({', '.join(sub_values)}) but GitHub presents the immutable-id "
            f"subject {subject}"
        )
    aud_ok = any(a == audience for a in aud_values)
    if not aud_ok:
        faults.append(
            "aud condition required "
            f"{', '.join(aud_values)} but the workflow requests audience {audience}"
        )
    # Repair in place: correct sub/aud AND pin the immutable identity claims.
    condition["StringLike"] = {f"{oidc_host}:sub": [f"repo:{repository}:*"]}
    condition["StringEquals"] = {
        f"{oidc_host}:aud": audience,
        f"{oidc_host}:repository_id": repository_id,
        f"{oidc_host}:repository_owner_id": repository_owner_id,
    }
    statement["Condition"] = condition
    patched = True
    print(f"patched statement {statement.get('Sid')}")
    break

if not patched:
    raise SystemExit("could not locate the failing federated statement")
if len(faults) < 2:
    raise SystemExit(f"expected two faults, only diagnosed: {faults}")

iam.update_assume_role_policy(RoleName=role_name, PolicyDocument=json.dumps(doc))
print("trust policy updated")

# 5. Confirm the persisted document.
persisted = iam.get_role(RoleName=role_name)["Role"]["AssumeRolePolicyDocument"]
flat = json.dumps(persisted)
assert f"repo:{repository}:*" in flat, "immutable-id subject pattern missing"
assert audience in flat, "requested audience not persisted"
assert repository_id in flat, "repository_id pin missing"
assert repository_owner_id in flat, "repository_owner_id pin missing"
print(json.dumps(persisted, indent=2))

with open("/logs/agent/agent-output.json", "w") as handle:
    json.dump(
        {
            "role_name": role_name,
            "subject_claim": subject,
            "audience_claim": audience,
            "repository_id": repository_id,
            "repository_owner_id": repository_owner_id,
            "token_source": f"s3://{bucket}/{best['Key']}",
            "faults_identified": faults,
        },
        handle,
        indent=2,
    )

with open("/logs/agent/agent-output.txt", "w") as handle:
    handle.write(
        f"The federated statement for {gh_repository} in the trust policy of "
        f"{role_name} failed two condition checks at once.\n"
        f"1. sub: the statement matched a slug pattern but the id_token presents "
        f"{subject} because the repository was created after GitHub switched new "
        "repositories to immutable organisation/repository id subjects.\n"
        f"2. aud: the statement required a different audience but the workflow "
        f"requests {audience}.\n"
        "Fixed by pointing the sub condition at "
        f"repo:{repository}:*, the aud condition at {audience}, and additionally "
        f"pinning repository_id={repository_id} and repository_owner_id={repository_owner_id} "
        "so the statement matches the immutable identity claims GitHub emits.\n"
        "The sibling statement for acme-corp/legacy-service already pins "
        "repository_id/repository_owner_id directly (with no sub condition) and is "
        "unaffected. Permissions were not changed.\n"
    )
PY

echo "solution complete"
cat /logs/agent/agent-output.json
