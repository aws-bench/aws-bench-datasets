#!/usr/bin/env python3
"""
Flint Motion Detection Service

Processes HLS video frames, runs motion detection, and reports
detected persons to the Quartz dependency service.
Publishes CloudWatch metrics and X-Ray traces.
"""

import time
import random
import logging
import os
import boto3
import json
from datetime import datetime

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(name)s:%(levelname)s: ts=%(created)f: pid=%(process)d: %(message)s",
)
logger = logging.getLogger("hls_client")

# AWS clients
cloudwatch = boto3.client(
    "cloudwatch", region_name=os.environ.get("AWS_REGION", "ap-southeast-1")
)
xray = boto3.client("xray", region_name=os.environ.get("AWS_REGION", "ap-southeast-1"))
ssm_client = boto3.client(
    "ssm", region_name=os.environ.get("AWS_REGION", "ap-southeast-1")
)

QUARTZ_LATENCY_MODE_PARAM = os.environ.get(
    "QUARTZ_LATENCY_MODE_PARAM", "/flint/prod/quartz-latency-mode"
)
PUBLISH_DEP_METRICS_PARAM = os.environ.get(
    "PUBLISH_DEP_METRICS_PARAM", "/flint/prod/publish-dependency-metrics"
)


def get_latency_mode() -> str:
    """Read current latency mode from SSM. Defaults to degraded on error."""
    try:
        return ssm_client.get_parameter(Name=QUARTZ_LATENCY_MODE_PARAM)["Parameter"][
            "Value"
        ]
    except Exception as e:
        logger.warning(
            f"Could not read latency mode from SSM, defaulting to degraded: {e}"
        )
        return "degraded"


def get_publish_dep_metrics() -> bool:
    """Read whether to publish Flint/Dependencies metrics from SSM. Defaults to True on error."""
    try:
        return (
            ssm_client.get_parameter(Name=PUBLISH_DEP_METRICS_PARAM)["Parameter"][
                "Value"
            ]
            == "true"
        )
    except Exception as e:
        logger.warning(
            f"Could not read publish-dependency-metrics from SSM, defaulting to True: {e}"
        )
        return True


def generate_trace_id():
    """Generate a unique X-Ray trace ID"""
    timestamp = hex(int(time.time()))[2:]
    unique_id = "".join([hex(random.randint(0, 15))[2:] for _ in range(24)])
    return f"1-{timestamp}-{unique_id}"


def publish_xray_trace(internal_time_ms, quartz_time_ms, total_time_ms):
    """
    Publish X-Ray trace showing latency breakdown

    This creates a trace with segments showing:
    - Root segment: Total frame processing time
    - Subsegment: Internal pipeline (fast, ~2s)
    - Subsegment: Quartz API call (slow, ~19s)
    """
    try:
        trace_id = generate_trace_id()
        start_time = time.time()

        # Root segment - total processing
        root_segment_id = "".join([hex(random.randint(0, 15))[2:] for _ in range(16)])

        # Internal pipeline subsegment
        internal_segment_id = "".join(
            [hex(random.randint(0, 15))[2:] for _ in range(16)]
        )
        internal_start = start_time
        internal_end = internal_start + (internal_time_ms / 1000.0)

        # Quartz API subsegment
        quartz_segment_id = "".join([hex(random.randint(0, 15))[2:] for _ in range(16)])
        quartz_start = internal_end
        quartz_end = quartz_start + (quartz_time_ms / 1000.0)

        # Root segment document
        root_segment = {
            "name": "FlintMotionDetection",
            "id": root_segment_id,
            "trace_id": trace_id,
            "start_time": start_time,
            "end_time": quartz_end,
            "subsegments": [
                {
                    "name": "InternalPipeline",
                    "id": internal_segment_id,
                    "start_time": internal_start,
                    "end_time": internal_end,
                    "metadata": {
                        "operations": {
                            "ProcessFrame": f"{internal_time_ms * 0.5:.1f}ms",
                            "MotionDetection": "1.6ms",
                            "HLSStartLag": f"{internal_time_ms * 0.5:.1f}ms",
                        }
                    },
                },
                {
                    "name": "QuartzAPI",
                    "id": quartz_segment_id,
                    "start_time": quartz_start,
                    "end_time": quartz_end,
                    "http": {
                        "request": {
                            "method": "POST",
                            "url": "https://quartz-api.internal.aws/v1/report-person",
                        },
                        "response": {"status": 200},
                    },
                    "metadata": {
                        "service": "Quartz",
                        "operation": "ReportPerson",
                        "latency_ms": quartz_time_ms,
                    },
                },
            ],
        }

        # Send trace to X-Ray
        xray.put_trace_segments(TraceSegmentDocuments=[json.dumps(root_segment)])

    except Exception as e:
        logger.error(f"Failed to publish X-Ray trace: {e}")


def publish_metric(metric_name, value, operation, unit="Milliseconds"):
    """Publish a metric to CloudWatch"""
    try:
        cloudwatch.put_metric_data(
            Namespace="Flint",
            MetricData=[
                {
                    "MetricName": metric_name,
                    "Dimensions": [
                        {"Name": "Camera_name", "Value": "ALL"},
                        {"Name": "Operation", "Value": operation},
                    ],
                    "Value": value,
                    "Unit": unit,
                    "Timestamp": datetime.utcnow(),
                },
            ],
        )
    except Exception as e:
        logger.error(f"Failed to publish metric {metric_name}: {e}")


def publish_quartz_api_metric(latency_ms):
    """Publish Quartz API latency metric to show external dependency performance"""
    try:
        cloudwatch.put_metric_data(
            Namespace="Flint/Dependencies",
            MetricData=[
                {
                    "MetricName": "APILatency",
                    "Dimensions": [
                        {"Name": "Service", "Value": "Quartz"},
                        {"Name": "Operation", "Value": "ReportPerson"},
                    ],
                    "Value": latency_ms,
                    "Unit": "Milliseconds",
                    "Timestamp": datetime.utcnow(),
                },
            ],
        )
    except Exception as e:
        logger.error(f"Failed to publish Quartz API metric: {e}")


def simulate_frame_processing():
    """Simulate processing a video frame"""
    frame_count = random.randint(20, 35)
    frame_ts = time.time() - random.uniform(1.8, 2.2)
    lag = time.time() - frame_ts

    logger.info(
        f"decode_fragment: {frame_count} enqueued frame_ts {frame_ts:.3f} since last 1.0 lag {lag:.3f}"
    )

    # Simulate frame processing time (500-900ms P90)
    process_time = random.uniform(450, 950)
    time.sleep(process_time / 1000.0)
    publish_metric("Time", process_time, "ProcessFrame")

    # Simulate motion detection (very fast, ~1.6ms)
    motion_time = random.uniform(1.5, 1.7)
    time.sleep(motion_time / 1000.0)
    publish_metric("Time", motion_time, "MotionDetection")

    # Simulate HLS start lag (~1 second)
    hls_lag = random.uniform(1000, 1070)
    publish_metric("Time", hls_lag, "HLSStartLag")

    # Simulate CPU utilization (~48%)
    cpu_pct = random.uniform(47.0, 49.0)
    publish_metric("NonIdlePct", cpu_pct, "CPU", "Percent")

    # Calculate internal pipeline time (ProcessFrame + MotionDetection + HLSStartLag)
    # This is the time spent in our service before calling Quartz
    internal_pipeline_time = process_time + motion_time + hls_lag
    publish_metric("Time", internal_pipeline_time, "InternalPipelineTime")

    # Quartz API latency depends on current mode (controlled via SSM)
    mode = get_latency_mode()
    if mode == "degraded":
        quartz_api_latency = random.uniform(18000, 20000)
    else:
        quartz_api_latency = random.uniform(2000, 4500)
    if get_publish_dep_metrics():
        publish_quartz_api_metric(quartz_api_latency)

    logger.info(
        f"quartz_api_call: operation=ReportPerson latency={quartz_api_latency:.1f}ms status=200"
    )

    frame_quartz_lag = internal_pipeline_time + quartz_api_latency
    publish_metric("Time", frame_quartz_lag, "FrameQuartzLag")

    # Generate X-Ray trace showing the latency breakdown
    publish_xray_trace(internal_pipeline_time, quartz_api_latency, frame_quartz_lag)


def main():
    """Main processing loop"""
    logger.info("Starting Flint Motion Detection Service")
    logger.info(
        f"Region: {os.environ.get('AWS_REGION')}, Cluster: {os.environ.get('CLUSTER_NAME')}, Stage: {os.environ.get('STAGE')}"
    )

    # Log ffmpeg startup message
    logger.info(
        "ffmpeg started: 'ffmpeg -loglevel error -hide_banner -i /dev/shm/hls/1769885121/combined.ts -r 4 -vf scale=640:360 -pix_fmt bgr24 -f rawvideo pipe:'"
    )

    while True:
        try:
            simulate_frame_processing()
            # Process frames every 10-15 seconds to generate enough data points
            time.sleep(random.uniform(10, 15))
        except KeyboardInterrupt:
            logger.info("Shutting down gracefully")
            break
        except Exception as e:
            logger.error(f"Error in processing loop: {e}")
            time.sleep(5)


if __name__ == "__main__":
    main()
