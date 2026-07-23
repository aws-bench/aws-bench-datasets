#!/usr/bin/env python3
"""
Tigris API Client

Simulates a service client that periodically calls the Tigris API through
the ALB. Reads the target endpoint path from an SSM parameter, allowing
external control to simulate a client-side endpoint misconfiguration.
"""

import logging
import os
import random
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

import boto3

logging.basicConfig(
    level=logging.INFO,
    format="%(name)s:%(levelname)s: ts=%(created)f: pid=%(process)d: %(message)s",
)
logger = logging.getLogger("tigris_client")

REGION = os.environ.get("AWS_REGION", "us-east-1")
ALB_DNS = os.environ["ALB_DNS_NAME"]
ENDPOINT_PATH_PARAM = os.environ.get(
    "ENDPOINT_PATH_PARAM", "/tigris/prod/service-config"
)

ssm = boto3.client("ssm", region_name=REGION)


def get_endpoint_path() -> str:
    try:
        return ssm.get_parameter(Name=ENDPOINT_PATH_PARAM)["Parameter"]["Value"]
    except Exception as e:
        logger.warning(
            f"Could not read endpoint path from SSM, defaulting to /jobInstance/updateStatus: {e}"
        )
        return "/jobInstance/updateStatus"


def send_request(path: str) -> int:
    url = f"http://{ALB_DNS}{path}"
    req = Request(url, method="POST", data=b"")
    try:
        with urlopen(req, timeout=10) as resp:
            return resp.status
    except HTTPError as e:
        return e.code
    except URLError as e:
        logger.error(f"Request failed: {e}")
        return 0


def main():
    logger.info(f"Starting Tigris API client targeting {ALB_DNS}")
    logger.info(f"SSM parameter: {ENDPOINT_PATH_PARAM}")

    while True:
        try:
            path = get_endpoint_path()
            batch_size = random.randint(3, 6)
            for _ in range(batch_size):
                status = send_request(path)
                logger.info(f"POST {path} -> {status}")
                time.sleep(random.uniform(0.5, 2.0))
            time.sleep(random.uniform(5, 10))
        except KeyboardInterrupt:
            logger.info("Shutting down")
            break
        except Exception as e:
            logger.error(f"Error in client loop: {e}")
            time.sleep(5)


if __name__ == "__main__":
    main()
