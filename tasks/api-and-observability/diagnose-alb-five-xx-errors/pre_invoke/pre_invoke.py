"""
Pre-invoke script for stack ecs-t81xcoww7 (api-and-observability)

What this does:
  Runs before each agent probe to produce a realistic ALB access log pattern:
  1. Clears existing log files from the ALB logs bucket
  2. Sets SSM endpoint path to /jobInstance/updateStatus (healthy)
  3. Waits ~3 min for the client to generate successful traffic
  4. Flips SSM to /jobInstance/ (broken)
  5. Waits ~3 min for the client to generate failing traffic
  6. Waits for ALB to flush error-phase logs to S3

  The agent then sees a real transition: steady 200s followed by a switch to 500s,
  produced by an actual ECS client service calling the ALB.

Prerequisites:
  - Stack must be deployed
  - AWS credentials must be active for the target account

Stack outputs used:
  ALBLogsBucketName, EndpointPathParamName
    from api-and-observability-ecs-t81xcoww7-us-east-1
"""

import json
import os
import logging
import sys
import time
from typing import Optional

import boto3
from botocore.config import Config


logger = logging.getLogger(__name__)
config = Config(connect_timeout=5, read_timeout=60)

REGION = "us-east-1"
STACK_NAME = "api-and-observability-ecs-t81xcoww7-us-east-1"
HEALTHY_PHASE_SECONDS = 180
BROKEN_PHASE_SECONDS = 180
S3_POLL_TIMEOUT = 480


RESULT_FILE = "/logs/pre_invoke/placeholder.json"


def run(
    session: Optional[boto3.Session] = None,
    region: str = REGION,
    **parameters,
):
    if session is None:
        session = boto3.Session(region_name=region)

    cfn = session.client("cloudformation", config=config, region_name=region)
    outputs = {
        o["OutputKey"]: o["OutputValue"]
        for o in cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]["Outputs"]
    }

    bucket_name = outputs["ALBLogsBucketName"]
    endpoint_param = outputs["EndpointPathParamName"]
    account = session.client("sts", config=config).get_caller_identity()["Account"]

    ssm = session.client("ssm", config=config, region_name=region)
    s3 = session.client("s3", config=config, region_name=region)

    # Clear existing log files
    prefix = f"AWSLogs/{account}/elasticloadbalancing/{REGION}/"
    paginator = s3.get_paginator("list_objects_v2")
    deleted = 0
    for page in paginator.paginate(Bucket=bucket_name, Prefix=prefix):
        objects = [{"Key": o["Key"]} for o in page.get("Contents", [])]
        if objects:
            s3.delete_objects(Bucket=bucket_name, Delete={"Objects": objects})
            deleted += len(objects)
    if deleted:
        logger.info(f"Deleted {deleted} existing log files")

    # Phase 1: healthy traffic
    ssm.put_parameter(
        Name=endpoint_param,
        Value="/jobInstance/updateStatus",
        Type="String",
        Overwrite=True,
    )
    logger.info(
        f"Set endpoint to /jobInstance/updateStatus — waiting {HEALTHY_PHASE_SECONDS}s for healthy traffic"
    )
    time.sleep(HEALTHY_PHASE_SECONDS)

    # Phase 2: broken traffic
    ssm.put_parameter(
        Name=endpoint_param, Value="/jobInstance/", Type="String", Overwrite=True
    )
    logger.info(
        f"Flipped endpoint to /jobInstance/ — waiting {BROKEN_PHASE_SECONDS}s for error traffic"
    )
    time.sleep(BROKEN_PHASE_SECONDS)

    # Wait for ALB to flush logs covering the broken phase.
    # ALB writes logs every 5 min; we need files created after the broken phase ended.
    flush_cutoff = time.time()
    logger.info("Waiting for ALB to flush error-phase logs to S3...")
    start = time.time()
    while time.time() - start < S3_POLL_TIMEOUT:
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=bucket_name, Prefix=prefix):
            for obj in page.get("Contents", []):
                if obj["LastModified"].timestamp() >= flush_cutoff:
                    logger.info(f"Fresh log file detected: {obj['Key']}")
                    return
        time.sleep(15)

    raise RuntimeError(
        f"Error-phase logs did not appear in S3 within {S3_POLL_TIMEOUT}s"
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    try:
        run()
    except Exception as e:
        print(f"pre_invoke failed: {e}", file=sys.stderr)
        sys.exit(1)
    os.makedirs(os.path.dirname(RESULT_FILE), exist_ok=True)
    with open(RESULT_FILE, "w") as f:
        json.dump({}, f)
