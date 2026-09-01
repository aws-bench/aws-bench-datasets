"""Post-deploy seeding for the checkout-worker background service.

Runs the real nightly build so the worker repository has an image, then scales
the worker service up. The worker is healthy - it exists so the delivery plane
looks like production and so a broken checkout-api rollout can be told apart
from a cluster-wide problem.
"""

from __future__ import annotations

import time
from typing import Any, Dict, Optional

import boto3

REGION = "us-east-1"
ENV_ID = "remediation-multiservice"
DELIVERY_STACK = f"{ENV_ID}-EcsDelivery-hp473c290-{REGION}"
PIPELINES_STACK = f"{ENV_ID}-Pipelines-p1gtxzog5-{REGION}"

BUILD_DEADLINE = 1500


def stack_outputs(cfn, stack_name: str) -> Dict[str, str]:
    desc = cfn.describe_stacks(StackName=stack_name)["Stacks"][0]
    return {o["OutputKey"]: o["OutputValue"] for o in desc.get("Outputs", [])}


def run_build(cb, project: str) -> Dict[str, Any]:
    build_id = cb.start_build(projectName=project)["build"]["id"]
    print(f"[setup-worker] started {project} build {build_id}")
    deadline = time.time() + BUILD_DEADLINE
    while time.time() < deadline:
        build = cb.batch_get_builds(ids=[build_id])["builds"][0]
        if build.get("buildComplete"):
            status = build.get("buildStatus")
            print(f"[setup-worker] {project} build {build_id} finished with {status}")
            if status != "SUCCEEDED":
                raise RuntimeError(f"{project} build {build_id} ended in {status}")
            return build
        time.sleep(15)
    raise RuntimeError(f"{project} build {build_id} did not finish in time")


def run(session: Optional[boto3.Session] = None, region: str = REGION, **kwargs):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY")

    cfn = session.client("cloudformation", region_name=region)
    ecr = session.client("ecr", region_name=region)
    ecs = session.client("ecs", region_name=region)
    cb = session.client("codebuild", region_name=region)

    delivery = stack_outputs(cfn, DELIVERY_STACK)
    pipelines = stack_outputs(cfn, PIPELINES_STACK)

    repo = delivery["WorkerRepoName"]
    cluster = delivery["ClusterName"]
    service = delivery["WorkerServiceName"]

    run_build(cb, pipelines["WorkerProjectName"])

    details = ecr.describe_images(
        repositoryName=repo, imageIds=[{"imageTag": "latest"}]
    )["imageDetails"]
    print(f"[setup-worker] worker latest -> {details[0]['imageDigest']}")

    svc = ecs.describe_services(cluster=cluster, services=[service])["services"][0]
    ecs.update_service(
        cluster=cluster,
        service=service,
        taskDefinition=svc["taskDefinition"],
        desiredCount=1,
        forceNewDeployment=True,
    )
    print(f"[setup-worker] waiting for {service} to stabilise")
    ecs.get_waiter("services_stable").wait(
        cluster=cluster,
        services=[service],
        WaiterConfig={"Delay": 15, "MaxAttempts": 80},
    )

    svc = ecs.describe_services(cluster=cluster, services=[service])["services"][0]
    if svc["runningCount"] < 1:
        raise RuntimeError("checkout-worker did not reach a running state")
    print("[setup-worker] checkout-worker is healthy")


if __name__ == "__main__":
    run()
