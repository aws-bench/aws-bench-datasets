"""
Pre-invoke script for the X-Ray variant of stack CloudWatch-89fb5762b (api-and-observability)

What this does:
  Same as pre_invoke_89fb5762b.py but additionally sets publish-dependency-metrics=false
  so the Flint/Dependencies Quartz API latency metric is suppressed. This forces the
  agent to use X-Ray traces to confirm the Quartz bottleneck rather than a conveniently
  named CloudWatch metric.

  1. Verifies the ECS service is running
  2. Sets publish-dependency-metrics=false (suppresses Flint/Dependencies metric)
  3. Resets SSM latency mode to 'healthy', backfills 3h of healthy metric history,
     and waits for alarm to return to OK
  4. Invokes Lambda to generate fresh logs
  5. Sets SSM latency mode to 'degraded' and waits for alarm to reach ALARM state

  Backfilling on every pre-invoke ensures the healthy baseline never ages out of
  CloudWatch's retention window, regardless of when the benchmark runs.

Prerequisites:
  - Stack must be deployed and setup script must have been run first
  - AWS credentials must be active for the target account

Stack outputs used:
  ClusterName, ServiceName, QuartzLatencyModeParamName, PublishDepMetricsParamName,
  ServiceLatencyAlarmName, QuartzBackfillFunctionName
    from api-and-observability-CloudWatch-89fb5762b-ap-southeast-1
"""

import json
import os
import logging
import random
import sys
import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional


import boto3
from botocore.config import Config

logger = logging.getLogger(__name__)
config = Config(connect_timeout=5, read_timeout=60)


REGION = "ap-southeast-1"
STACK_NAME = "api-and-observability-CloudWatch-89fb5762b-ap-southeast-1"


def _flint_metric(
    name: str, value: float, operation: str, unit: str, ts: datetime
) -> Dict:
    return {
        "MetricName": name,
        "Dimensions": [
            {"Name": "Camera_name", "Value": "ALL"},
            {"Name": "Operation", "Value": operation},
        ],
        "Value": value,
        "Unit": unit,
        "Timestamp": ts,
    }


def _put_batch(cw, namespace: str, metrics: List[Dict]) -> None:
    for i in range(0, len(metrics), 1000):
        cw.put_metric_data(Namespace=namespace, MetricData=metrics[i : i + 1000])


def backfill_healthy_history(cw) -> None:
    """Backfill ~3 hours of healthy Flint metrics. Intentionally skips Flint/Dependencies
    so the agent cannot use CloudWatch to confirm the Quartz bottleneck."""
    now = datetime.utcnow().replace(second=0, microsecond=0)
    flint_metrics = []

    ts = now - timedelta(hours=3)
    interval = timedelta(seconds=12)

    while ts < now - timedelta(minutes=5):
        process_frame = random.uniform(450, 750)
        motion = random.uniform(1.5, 1.7)
        hls_lag = random.uniform(950, 1100)
        internal = process_frame + motion + hls_lag
        quartz_api = random.uniform(2000, 4500)
        frame_quartz_lag = internal + quartz_api
        cpu = random.uniform(44.0, 52.0)

        flint_metrics += [
            _flint_metric("Time", process_frame, "ProcessFrame", "Milliseconds", ts),
            _flint_metric("Time", motion, "MotionDetection", "Milliseconds", ts),
            _flint_metric("Time", hls_lag, "HLSStartLag", "Milliseconds", ts),
            _flint_metric("Time", internal, "InternalPipelineTime", "Milliseconds", ts),
            _flint_metric(
                "Time", frame_quartz_lag, "FrameQuartzLag", "Milliseconds", ts
            ),
            _flint_metric("NonIdlePct", cpu, "CPU", "Percent", ts),
        ]

        ts += interval + timedelta(seconds=random.uniform(-1, 1))

    logger.info(
        f"Backfilling {len(flint_metrics)} Flint metrics (Flint/Dependencies intentionally skipped)..."
    )
    _put_batch(cw, "Flint", flint_metrics)
    logger.info("Backfill complete")


RESULT_FILE = "/logs/pre_invoke/placeholder.json"


def run(
    session: Optional[boto3.Session] = None,
    region: str = REGION,
    **parameters,
):
    if session is None:
        session = boto3.Session(region_name=region)

    cfn = session.client("cloudformation", config=config, region_name=region)
    ecs = session.client("ecs", config=config, region_name=region)
    lambda_client = session.client("lambda", config=config, region_name=region)
    cw = session.client("cloudwatch", config=config, region_name=region)
    ssm = session.client("ssm", config=config, region_name=region)

    outputs = {
        o["OutputKey"]: o["OutputValue"]
        for o in cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]["Outputs"]
    }

    cluster_name = outputs["ClusterName"]
    service_name = outputs["ServiceName"]
    latency_mode_param = outputs["QuartzLatencyModeParamName"]
    publish_dep_metrics_param = outputs["PublishDepMetricsParamName"]
    alarm_name = outputs["ServiceLatencyAlarmName"]
    lambda_function_name = outputs["QuartzBackfillFunctionName"]

    # Verify ECS service is running
    svc = ecs.describe_services(cluster=cluster_name, services=[service_name])[
        "services"
    ][0]
    running, desired = svc["runningCount"], svc["desiredCount"]
    logger.info(f"ECS service status: {running}/{desired} tasks running")
    if running < desired:
        logger.warning("ECS service has fewer running tasks than desired")

    # Suppress Flint/Dependencies metric — agent must use X-Ray to confirm root cause
    ssm.put_parameter(Name=publish_dep_metrics_param, Value="false", Overwrite=True)
    logger.info("Flint/Dependencies metric publishing disabled")

    # Reset to healthy — alarm should return to OK within ~3-4 min
    ssm.put_parameter(Name=latency_mode_param, Value="healthy", Overwrite=True)
    logger.info(
        "SSM latency mode set to healthy — waiting for alarm to return to OK..."
    )

    # Backfill fresh healthy history so the 3h baseline never ages out
    backfill_healthy_history(cw)

    deadline = time.time() + 300
    while time.time() < deadline:
        state = cw.describe_alarms(AlarmNames=[alarm_name])["MetricAlarms"][0][
            "StateValue"
        ]
        logger.info(f"Alarm state: {state}")
        if state == "OK":
            break
        time.sleep(20)
    else:
        logger.warning("Alarm did not return to OK within timeout — proceeding anyway")

    # Invoke Lambda to generate fresh logs
    lambda_client.invoke(
        FunctionName=lambda_function_name,
        InvocationType="RequestResponse",
        Payload=b'{"isPulling": "True", "queueName": "quartzBackfillQueueDlq"}',
    )
    logger.info("Lambda invoked successfully")

    # Switch to degraded — alarm should fire within ~3 min
    ssm.put_parameter(Name=latency_mode_param, Value="degraded", Overwrite=True)
    logger.info("SSM latency mode set to degraded — waiting for alarm to fire...")

    deadline = time.time() + 300
    while time.time() < deadline:
        state = cw.describe_alarms(AlarmNames=[alarm_name])["MetricAlarms"][0][
            "StateValue"
        ]
        logger.info(f"Alarm state: {state}")
        if state == "ALARM":
            logger.info("Alarm is in ALARM state — ready for agent probe")
            break
        time.sleep(20)
    else:
        logger.warning("Alarm did not reach ALARM state within timeout")

    final_state = cw.describe_alarms(AlarmNames=[alarm_name])["MetricAlarms"][0][
        "StateValue"
    ]
    logger.info(
        f"Final state: cluster={cluster_name}, alarm={alarm_name}, state={final_state}"
    )

    if final_state != "ALARM":
        raise RuntimeError(f"Alarm did not reach ALARM state, got: {final_state}")
    return


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
