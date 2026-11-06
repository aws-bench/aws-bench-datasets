#!/bin/bash
set -euo pipefail
pip install boto3
python3 ./pre_invoke.py
