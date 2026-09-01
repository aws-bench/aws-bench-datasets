#!/bin/bash
# Runs from this script's own directory: the task container mounts it at
# /post_invoke, while the scenario reset phase runs the same folder from
# /reset/post_invokes/<task-name>/.
set -euo pipefail
cd "$(dirname "$0")"
python3 post_invoke.py
