#!/bin/bash
set -euo pipefail
uv run --with boto3 pre_invoke.py
