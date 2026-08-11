#!/bin/bash
set -euo pipefail
uv run --with boto3 --with pillow pre_invoke.py
