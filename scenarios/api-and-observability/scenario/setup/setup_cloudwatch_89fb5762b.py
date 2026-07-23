"""
Setup script for stack CloudWatch-89fb5762b (api-and-observability).

What this does:
  1. Waits for the ECS service to have running tasks
  2. Invokes the Lambda function to generate initial logs
  3. Backfills ~3 hours of healthy metric history via put_metric_data
  4. Sets the SSM latency mode parameter to 'degraded' so the live ECS task
     starts publishing elevated Quartz API latency metrics
  5. Waits for the alarm to transition to ALARM state (~3-5 min)
  6. Resets SSM back to 'healthy' so the stack publishes healthy metrics while
     idle — ensures pre-invoke backfill aligns with live data on future runs

Backfilling rationale:
  Ideally this environment would be deployed and left running overnight so the alarm
  has genuine organic history. However, the benchmark requires deploy-and-run within
  30 minutes. We therefore backfill synthetic healthy history so the alarm does not
  appear brand-new to the agent. The degradation itself is real — driven by the live
  ECS task once the SSM flag is set to 'degraded'.
"""

import random
import sys
import time
from datetime import datetime, timedelta
from typing import Dict, List, Optional

import boto3
from botocore.config import Config

config = Config(connect_timeout=5, read_timeout=60)

REGION = "ap-southeast-1"
ENV_ID = "api-and-observability"


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


def _dep_metric(value: float, ts: datetime) -> Dict:
    return {
        "MetricName": "APILatency",
        "Dimensions": [
            {"Name": "Service", "Value": "Quartz"},
            {"Name": "Operation", "Value": "ReportPerson"},
        ],
        "Value": value,
        "Unit": "Milliseconds",
        "Timestamp": ts,
    }


def _put_batch(cw, namespace: str, metrics: List[Dict]) -> None:
    for i in range(0, len(metrics), 1000):
        cw.put_metric_data(Namespace=namespace, MetricData=metrics[i : i + 1000])


def backfill_healthy_history(cw) -> None:
    """Backfill ~3 hours of healthy metrics so the alarm has realistic history."""
    now = datetime.utcnow().replace(second=0, microsecond=0)
    flint_metrics = []
    dep_metrics = []

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
        dep_metrics.append(_dep_metric(quartz_api, ts))

        ts += interval + timedelta(seconds=random.uniform(-1, 1))

    print(
        f"Backfilling {len(flint_metrics)} Flint metrics and {len(dep_metrics)} dependency metrics..."
    )
    _put_batch(cw, "Flint", flint_metrics)
    _put_batch(cw, "Flint/Dependencies", dep_metrics)
    print("Backfill complete")


def run(session: Optional[boto3.Session] = None, region: str = REGION, **parameters):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY")

    cfn = session.client("cloudformation", config=config, region_name=region)
    ecs = session.client("ecs", config=config, region_name=region)
    lambda_client = session.client("lambda", config=config, region_name=region)
    cw = session.client("cloudwatch", config=config, region_name=region)
    ssm = session.client("ssm", config=config, region_name=region)

    outputs = {
        o["OutputKey"]: o["OutputValue"]
        for o in cfn.describe_stacks(
            StackName=f"{ENV_ID}-CloudWatch-89fb5762b-{region}"
        )["Stacks"][0]["Outputs"]
    }

    cluster_name = outputs["ClusterName"]
    service_name = outputs["ServiceName"]
    latency_mode_param = outputs["QuartzLatencyModeParamName"]
    alarm_name = outputs["ServiceLatencyAlarmName"]
    lambda_function_name = outputs["QuartzBackfillFunctionName"]

    print(f"ECS cluster: {cluster_name}, service: {service_name}")
    print(f"Alarm: {alarm_name}")

    # Wait for ECS service to have running tasks
    print("Waiting for ECS service to start tasks...")
    deadline = time.time() + 300
    ecs_ready = False
    while time.time() < deadline:
        svc = ecs.describe_services(cluster=cluster_name, services=[service_name])[
            "services"
        ][0]
        running, desired = svc["runningCount"], svc["desiredCount"]
        print(f"Service status: {running}/{desired} tasks running")
        if running >= desired and running > 0:
            ecs_ready = True
            break
        time.sleep(10)
    if not ecs_ready:
        print(
            f"ECS service {service_name} did not reach desired capacity within 300s",
            file=sys.stderr,
        )
        return {"success": False, "output_values": None}

    # Give the task time to start its metric publishing loop
    print("Waiting 20s for task to initialize metric publishing...")
    time.sleep(20)

    # Invoke Lambda to generate initial logs (retry for IAM propagation)
    for attempt in range(6):
        try:
            lambda_client.invoke(
                FunctionName=lambda_function_name,
                InvocationType="RequestResponse",
                Payload=b'{"isPulling": "True", "queueName": "quartzBackfillQueueDlq"}',
            )
            print("Lambda invoked successfully")
            break
        except Exception as e:
            if "AccessDeniedException" in str(e) and attempt < 5:
                print(
                    f"Lambda role not ready (attempt {attempt + 1}/6), waiting 10s..."
                )
                time.sleep(10)
            else:
                raise

    # Ensure SSM starts in healthy mode
    ssm.put_parameter(Name=latency_mode_param, Value="healthy", Overwrite=True)
    print("SSM latency mode set to healthy")

    # Backfill healthy history
    backfill_healthy_history(cw)

    # Switch to degraded mode — live ECS task will start publishing high latency
    ssm.put_parameter(Name=latency_mode_param, Value="degraded", Overwrite=True)
    print("SSM latency mode set to degraded — waiting for alarm to fire...")

    # Wait for alarm to reach ALARM state
    # Alarm needs 3 consecutive 1-min periods breaching + CloudWatch evaluation lag (~1-2 min)
    # Total expected time: ~5 min from first degraded metric
    deadline = time.time() + 420
    alarm_fired = False
    while time.time() < deadline:
        state = cw.describe_alarms(AlarmNames=[alarm_name])["MetricAlarms"][0][
            "StateValue"
        ]
        print(f"Alarm state: {state}")
        if state == "ALARM":
            print("Alarm is in ALARM state")
            alarm_fired = True
            break
        time.sleep(30)

    final_state = cw.describe_alarms(AlarmNames=[alarm_name])["MetricAlarms"][0][
        "StateValue"
    ]
    if not alarm_fired:
        print(
            f"Alarm did not reach ALARM state within 420s, currently {final_state}",
            file=sys.stderr,
        )

    # Reset to healthy so the stack publishes healthy metrics while idle.
    # This ensures the pre-invoke backfill aligns with live data when the
    # benchmark is run later (even days after setup).
    ssm.put_parameter(Name=latency_mode_param, Value="healthy", Overwrite=True)
    print(
        "SSM latency mode reset to healthy — stack will publish healthy metrics while idle"
    )

    if not alarm_fired:
        return {"success": False, "output_values": None}

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
