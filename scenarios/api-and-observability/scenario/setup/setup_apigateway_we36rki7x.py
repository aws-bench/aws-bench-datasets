"""
Setup script for stack apigateway-we36rki7x (api-and-observability).
Connects to the WebSocket API once to trigger a real Lambda error,
ensuring CloudWatch logs exist before the agent starts investigating.
"""

import json
import socket
import ssl
import struct
import sys
import traceback
import urllib.parse
from typing import Optional

import boto3
from botocore.config import Config


REGION = "us-east-1"
STACK_NAME = "api-and-observability-apigateway-we36rki7x-us-east-1"

WS_KEY = "dGhlIHNhbXBsZSBub25jZQ=="
WS_MASK = b"\x01\x02\x03\x04"


def _ws_connect_and_send(url, payload, timeout=5):
    """Connect to a wss:// URL, send one message, return response or None.

    Returns the response string on success, None on timeout, or raises
    RuntimeError only for network-level failures. A non-101 HTTP response
    (e.g. 502) is returned as a string prefixed with 'HTTP_ERROR:'.
    """
    parsed = urllib.parse.urlparse(url)
    raw = socket.create_connection((parsed.hostname, 443), timeout=timeout)
    try:
        context = ssl.create_default_context()
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        sock = context.wrap_socket(raw, server_hostname=parsed.hostname)
    except Exception:
        raw.close()
        raise
    try:
        # Handshake
        sock.sendall(
            f"GET {parsed.path or '/'} HTTP/1.1\r\n"
            f"Host: {parsed.hostname}\r\n"
            f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {WS_KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode()
        )
        response = sock.recv(4096).decode()
        if "101" not in response:
            # Non-101 means the server rejected the upgrade (e.g. Lambda errored).
            # This still generates CloudWatch logs, which is what we need.
            return f"HTTP_ERROR:{response.splitlines()[0] if response else 'empty'}"

        # Send masked text frame
        data = payload.encode()
        masked = bytes(b ^ WS_MASK[i % 4] for i, b in enumerate(data))
        sock.sendall(struct.pack("BB", 0x81, 0x80 | len(data)) + WS_MASK + masked)

        # Read response
        try:
            hdr = sock.recv(2)
            if len(hdr) < 2:
                return None
            length = hdr[1] & 0x7F
            if length == 126:
                length = struct.unpack(">H", sock.recv(2))[0]
            return sock.recv(length).decode()
        except socket.timeout:
            return None
    finally:
        sock.close()


def run(session: Optional[boto3.Session] = None, region: str = REGION, **parameters):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY")

    cfn = session.client(
        "cloudformation",
        config=Config(connect_timeout=5, read_timeout=60),
        region_name=region,
    )
    outputs = {
        o["OutputKey"]: o["OutputValue"]
        for o in cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]["Outputs"]
    }

    ws_url = outputs["WebSocketApiEndpoint"]
    print(f"Connecting to {ws_url}")

    msg = json.dumps(
        {
            "action": "agent_connected",
            "hostname": "setup-probe",
            "ip": "127.0.0.1",
            "agentVersion": "1.0.0",
        }
    )
    resp = _ws_connect_and_send(ws_url, msg)

    if resp and resp.startswith("HTTP_ERROR:"):
        print(f"Connection rejected by server: {resp}")
        print("Lambda error triggered successfully (CloudWatch logs generated)")
    elif resp and "registration_success" in resp:
        raise RuntimeError(
            "WEBSOCKET_ENDPOINT appears to be configured — expected it to be missing"
        )
    else:
        print("No response received (expected — Lambda should have errored)")

    return {"success": True, "output_values": None}


if __name__ == "__main__":
    try:
        result = run()
        if not result.get("success"):
            sys.exit(1)
    except Exception:
        traceback.print_exc()
        sys.exit(1)
