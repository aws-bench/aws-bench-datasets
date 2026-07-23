#!/bin/bash
set -euo pipefail
uv run --with boto3 --with pymysql post_invoke.py