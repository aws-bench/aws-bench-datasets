"""Assert the post-setup state the account snapshot cannot see.

Everything the nine `setup_*.py` scripts establish is data-plane — DynamoDB
items, S3 objects, SSM parameter values, ECR image tags, ECS running tasks —
and none of it appears in a CloudFormation-resource snapshot.

Every check is read-only and idempotent. Checks assert existence and shape,
not exact values, because tasks legitimately mutate this data.
"""

from __future__ import annotations

import boto3
from botocore.exceptions import ClientError

REGION = "us-east-1"

INGEST_STACK = "remediation-multiservice-Ingest-ay9wdpt5n-us-east-1"
LEDGER_STACK = "remediation-multiservice-Ledger-qxoqk9o4y-us-east-1"
FULFILLMENT_STACK = "remediation-multiservice-Fulfillment-5k53ncku2-us-east-1"
BEDROCK_STACK = "remediation-multiservice-Bedrock-uyvjsf7fj-us-east-1"
WEBPLATFORM_STACK = "remediation-multiservice-WebPlatform-uobyzx8z7-us-east-1"
CICD_STACK = "remediation-multiservice-CicdOidc-a2ltm5dey-us-east-1"
ECS_STACK = "remediation-multiservice-EcsDelivery-hp473c290-us-east-1"
GUARDRAIL_STACK = "remediation-multiservice-Platform-5sp83dcvi-us-east-1"

# setup_bedrock_extraction_uyvjsf7fj.py seeds one row per extraction profile.
BEDROCK_PROFILE_IDS = (
    "contracts_v4",
    "contracts_v5",
    "invoices_v7",
    "legacy_faxes_v1",
    "purchase_orders_v2",
    "receipts_v2",
    "receipts_v3",
    "remittance_v1",
    "statements_v3",
)

# setup_ingest_ay9wdpt5n.py seeds SKU-1000 .. SKU-1039.
INGEST_INVENTORY_MIN = 40

# setup_checkout_delivery_hp473c290.py drives CodeBuild to publish these releases.
CHECKOUT_RELEASE_TAGS = ("v2.0", "v2.1")


def _outputs(cfn, stack_name: str) -> dict:
    stacks = cfn.describe_stacks(StackName=stack_name)["Stacks"]
    return {o["OutputKey"]: o["OutputValue"] for o in stacks[0].get("Outputs", [])}


def _item_count(ddb, table_name: str) -> int:
    """Total items in a table. These tables hold tens of rows, so a scan is fine."""
    total = 0
    kwargs: dict = {"TableName": table_name, "Select": "COUNT"}
    while True:
        resp = ddb.scan(**kwargs)
        total += resp["Count"]
        if "LastEvaluatedKey" not in resp:
            return total
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]


def _object_count(s3, bucket: str, prefix: str = "") -> int:
    total = 0
    for page in s3.get_paginator("list_objects_v2").paginate(
        Bucket=bucket, Prefix=prefix
    ):
        total += page.get("KeyCount", 0)
    return total


def _has_object(s3, bucket: str, key: str) -> bool:
    try:
        s3.head_object(Bucket=bucket, Key=key)
        return True
    except ClientError:
        return False


def check_ingest(session) -> list[str]:
    """setup_ingest_ay9wdpt5n.py — inventory catalog and processing history."""
    fails = []
    cfn = session.client("cloudformation", region_name=REGION)
    ddb = session.client("dynamodb", region_name=REGION)
    out = _outputs(cfn, INGEST_STACK)

    inventory = _item_count(ddb, out["InventoryTableName"])
    if inventory < INGEST_INVENTORY_MIN:
        fails.append(
            f"inventory catalog has {inventory} row(s), expected >= {INGEST_INVENTORY_MIN} "
            f"({out['InventoryTableName']}) — setup_ingest_ay9wdpt5n.py did not finish seeding"
        )

    for key in ("OrdersTableName", "NotificationsTableName"):
        if _item_count(ddb, out[key]) == 0:
            fails.append(
                f"{key} ({out[key]}) is empty — setup_ingest_ay9wdpt5n.py backfills "
                "processing history for both lanes"
            )

    sqs = session.client("sqs", region_name=REGION)
    try:
        sqs.get_queue_attributes(
            QueueUrl=out["OrdersQueueUrl"], AttributeNames=["QueueArn"]
        )
    except ClientError as exc:
        fails.append(f"orders queue {out['OrdersQueueUrl']} is not readable: {exc}")

    return fails


def check_ledger(session) -> list[str]:
    """setup_ledger_qxoqk9o4y.py — historical rows written through the backfill role."""
    fails = []
    cfn = session.client("cloudformation", region_name=REGION)
    ddb = session.client("dynamodb", region_name=REGION)
    out = _outputs(cfn, LEDGER_STACK)

    if _item_count(ddb, out["LedgerTableName"]) == 0:
        fails.append(
            f"ledger table {out['LedgerTableName']} is empty — setup_ledger_qxoqk9o4y.py "
            "seeds historical transactions through the backfill job, and the KMS task's "
            "reader path depends on them"
        )

    for key in ("AuditTableName", "AnalyticsTableName"):
        try:
            ddb.describe_table(TableName=out[key])
        except ClientError as exc:
            fails.append(f"{key} ({out[key]}) is not describable: {exc}")

    return fails


def check_fulfillment(session) -> list[str]:
    """setup_fulfillment_5k53ncku2.py — tier policy rows and a primed shipped rule."""
    fails = []
    cfn = session.client("cloudformation", region_name=REGION)
    ddb = session.client("dynamodb", region_name=REGION)
    events = session.client("events", region_name=REGION)
    out = _outputs(cfn, FULFILLMENT_STACK)

    if _item_count(ddb, out["TierPolicyTableName"]) == 0:
        fails.append(
            f"tier policy table {out['TierPolicyTableName']} is empty — "
            "setup_fulfillment_5k53ncku2.py seeds the SLA tiers the processor reads"
        )

    # The fulfillment rules live on a dedicated prod bus, not the default one.
    rule, bus = out["ShippedRuleName"], out["ProdBusName"]
    try:
        targets = events.list_targets_by_rule(Rule=rule, EventBusName=bus)["Targets"]
    except ClientError as exc:
        fails.append(f"shipped rule {rule} is not readable: {exc}")
    else:
        if not targets:
            fails.append(
                f"shipped rule {rule} has no targets — the pipeline is not wired"
            )
        elif not any(t.get("InputTransformer") for t in targets):
            fails.append(
                f"no target on {rule} carries an InputTransformer — the eventbridge task's "
                "entire premise is that one exists and is misconfigured"
            )

    return fails


def check_bedrock(session) -> list[str]:
    """setup_bedrock_extraction_uyvjsf7fj.py — profile rows and sample documents."""
    fails = []
    cfn = session.client("cloudformation", region_name=REGION)
    ddb = session.client("dynamodb", region_name=REGION)
    s3 = session.client("s3", region_name=REGION)
    out = _outputs(cfn, BEDROCK_STACK)

    table = out["ProfilesTableName"]
    present = set()
    kwargs: dict = {"TableName": table}
    while True:
        resp = ddb.scan(**kwargs)
        for item in resp["Items"]:
            for field in ("profileId", "profile_id", "id"):
                if field in item and "S" in item[field]:
                    present.add(item[field]["S"])
                    break
        if "LastEvaluatedKey" not in resp:
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]

    missing = [p for p in BEDROCK_PROFILE_IDS if p not in present]
    if missing:
        fails.append(
            f"extraction profiles missing from {table}: {', '.join(missing)} — "
            "setup_bedrock_extraction_uyvjsf7fj.py seeds one row per profile and the "
            "verifier's sweep enumerates all of them"
        )

    docs = _object_count(s3, out["DocumentsBucketName"])
    if docs == 0:
        fails.append(
            f"documents bucket {out['DocumentsBucketName']} is empty — the router has "
            "nothing to extract from"
        )

    return fails


def check_webplatform(session) -> list[str]:
    """setup_webplatform_uobyzx8z7.py — build artifacts and publisher configuration."""
    fails = []
    cfn = session.client("cloudformation", region_name=REGION)
    s3 = session.client("s3", region_name=REGION)
    ssm = session.client("ssm", region_name=REGION)
    out = _outputs(cfn, WEBPLATFORM_STACK)

    prefix = out.get("SourcePrefix", "releases/current/")
    build_objects = _object_count(s3, out["BuildArtifactsBucketName"], prefix)
    if build_objects == 0:
        fails.append(
            f"no build artifacts under {out['BuildArtifactsBucketName']}/{prefix} — "
            "setup_webplatform_uobyzx8z7.py publishes the current build there and the "
            "cloudfront task compares the origin against it"
        )

    for key in ("MktgSyncModeParameterName", "RoleBaselineParameterName"):
        name = out.get(key)
        if not name:
            fails.append(f"stack output {key} is absent from {WEBPLATFORM_STACK}")
            continue
        try:
            ssm.get_parameter(Name=name)
        except ClientError as exc:
            fails.append(f"{key} ({name}) is not readable: {exc}")

    return fails


def check_cicd(session) -> list[str]:
    """setup_cicd_a2ltm5dey.py — captured run logs and the OIDC claims template."""
    fails = []
    cfn = session.client("cloudformation", region_name=REGION)
    s3 = session.client("s3", region_name=REGION)
    ssm = session.client("ssm", region_name=REGION)
    out = _outputs(cfn, CICD_STACK)

    bucket = out["ArtifactBucketName"]
    for key_output in ("PaymentsRunLogKey", "LegacyRunLogKey", "StagingRunLogKey"):
        key = out.get(key_output)
        if not key:
            fails.append(f"stack output {key_output} is absent from {CICD_STACK}")
        elif not _has_object(s3, bucket, key):
            fails.append(
                f"run log s3://{bucket}/{key} is missing — setup_cicd_a2ltm5dey.py captures "
                "it, and it is how the github-oidc task's failing build is diagnosed"
            )

    claims_param = out.get("PaymentsClaimsTemplateParameterName")
    if not claims_param:
        fails.append(
            f"stack output PaymentsClaimsTemplateParameterName is absent from {CICD_STACK}"
        )
    else:
        try:
            ssm.get_parameter(Name=claims_param)
        except ClientError as exc:
            fails.append(f"claims template {claims_param} is not readable: {exc}")

    return fails


def check_ecs_delivery(session) -> list[str]:
    """setup_checkout_delivery_hp473c290.py — published release images and a live service."""
    fails = []
    cfn = session.client("cloudformation", region_name=REGION)
    ecr = session.client("ecr", region_name=REGION)
    ecs = session.client("ecs", region_name=REGION)
    iam = session.client("iam", region_name=REGION)
    out = _outputs(cfn, ECS_STACK)

    repo = out["CheckoutRepoName"]
    try:
        tags: set[str] = set()
        for page in ecr.get_paginator("list_images").paginate(repositoryName=repo):
            for image in page["imageIds"]:
                if "imageTag" in image:
                    tags.add(image["imageTag"])
    except ClientError as exc:
        fails.append(f"ECR repository {repo} is not readable: {exc}")
    else:
        missing = [t for t in CHECKOUT_RELEASE_TAGS if t not in tags]
        if missing:
            fails.append(
                f"release tag(s) {', '.join(missing)} absent from {repo} — "
                "setup_checkout_delivery_hp473c290.py drives CodeBuild to publish them, and "
                "the ECS task's immutability checks operate on them"
            )

    worker_repo = out.get("WorkerRepoName")
    if worker_repo:
        try:
            worker_images = ecr.list_images(repositoryName=worker_repo)["imageIds"]
        except ClientError as exc:
            fails.append(f"ECR repository {worker_repo} is not readable: {exc}")
        else:
            if not worker_images:
                fails.append(
                    f"{worker_repo} holds no images — setup_checkout_worker_k0wms2i88.py "
                    "builds the worker image"
                )

    # A task execution role with no inline policy cannot call
    # ecr:GetAuthorizationToken, so every task launch fails with
    # "ResourceInitializationError: unable to pull registry auth" while
    # CloudFormation still reports the stack complete.
    for page in iam.get_paginator("list_roles").paginate():
        for role in page["Roles"]:
            # CloudFormation truncates generated names, so the trailing "e" of
            # "...ExecutionRole" is not always present.
            if "TaskDefExecutionRol" not in role["RoleName"]:
                continue
            inline: list[str] = []
            for policy_page in iam.get_paginator("list_role_policies").paginate(
                RoleName=role["RoleName"]
            ):
                inline.extend(policy_page["PolicyNames"])
            if not inline:
                fails.append(
                    f"task execution role {role['RoleName']} has no inline policy — "
                    "it cannot pull from ECR, so no Fargate task can start"
                )

    # The task subnets are PRIVATE_ISOLATED with no NAT, so a Fargate task reaches
    # ECR only through the interface endpoints, which needs egress on the task's own
    # security group. With egress empty the service never stabilises, while
    # CloudFormation still reports the stack complete.
    ec2 = session.client("ec2", region_name=REGION)
    for group_name in ("checkout-api-task-sg", "checkout-worker-task-sg"):
        try:
            groups = ec2.describe_security_groups(
                Filters=[{"Name": "group-name", "Values": [group_name]}]
            )["SecurityGroups"]
        except ClientError as exc:
            fails.append(f"security group {group_name} is not readable: {exc}")
            continue
        if not groups:
            fails.append(f"security group {group_name} not found")
        elif not groups[0].get("IpPermissionsEgress"):
            fails.append(
                f"security group {group_name} ({groups[0]['GroupId']}) has no egress rules — "
                "Fargate tasks in the isolated subnets cannot reach the ECR interface "
                "endpoints, so no task can start"
            )

    cluster, service = out["ClusterName"], out["CheckoutServiceName"]
    try:
        described = ecs.describe_services(cluster=cluster, services=[service])[
            "services"
        ]
    except ClientError as exc:
        fails.append(f"ECS service {service} is not describable: {exc}")
    else:
        if not described:
            fails.append(f"ECS service {service} not found in cluster {cluster}")
        elif described[0]["runningCount"] == 0:
            fails.append(
                f"ECS service {service} has runningCount 0 — setup brings it up to 2 tasks, "
                "and the ECS task starts from a service that is actually serving"
            )

    return fails


def check_guardrail_platform(session) -> list[str]:
    """setup_platform_5sp83dcvi.py — governed queues and the guardrail audit trail."""
    fails = []
    cfn = session.client("cloudformation", region_name=REGION)
    sqs = session.client("sqs", region_name=REGION)
    ddb = session.client("dynamodb", region_name=REGION)
    out = _outputs(cfn, GUARDRAIL_STACK)

    for key in ("GovernedOrdersQueueName", "GovernedPaymentsQueueName"):
        name = out.get(key)
        if not name:
            fails.append(f"stack output {key} is absent from {GUARDRAIL_STACK}")
            continue
        try:
            sqs.get_queue_url(QueueName=name)
        except ClientError as exc:
            fails.append(f"{key} ({name}) is not resolvable: {exc}")

    audit = out.get("GuardrailAuditTableName")
    if audit:
        try:
            ddb.describe_table(TableName=audit)
        except ClientError as exc:
            fails.append(f"guardrail audit table {audit} is not describable: {exc}")

    return fails


CHECKS = (
    ("ingest", check_ingest),
    ("ledger", check_ledger),
    ("fulfillment", check_fulfillment),
    ("bedrock", check_bedrock),
    ("webplatform", check_webplatform),
    ("cicd-oidc", check_cicd),
    ("ecs-delivery", check_ecs_delivery),
    ("guardrail-platform", check_guardrail_platform),
)


def main() -> int:
    session = boto3.Session(region_name=REGION)
    failures: list[str] = []

    for name, check in CHECKS:
        try:
            domain_failures = check(session)
        except ClientError as exc:
            # A stack that is absent or unreadable is itself a verify failure; report
            # it against the domain rather than aborting the remaining checks.
            failures.append(f"[{name}] could not be checked: {exc}")
            print(f"FAIL {name}: {exc}")
            continue
        if domain_failures:
            failures.extend(f"[{name}] {f}" for f in domain_failures)
            for f in domain_failures:
                print(f"FAIL {name}: {f}")
        else:
            print(f"OK   {name}")

    if failures:
        print(f"\nverify failed: {len(failures)} assertion(s) did not pass")
        for f in failures:
            print(f"  - {f}")
        return 1

    print("\nAll scenario-specific assertions passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
