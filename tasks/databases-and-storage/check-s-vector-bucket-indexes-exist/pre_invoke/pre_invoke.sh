#!/bin/bash
set -euo pipefail
pip install boto3 -q
python3 "$(dirname "$0")/pre_invoke.py"
