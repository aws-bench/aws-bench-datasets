#!/bin/bash
set -euo pipefail
uv run --with boto3 post_invoke.py
