#!/bin/bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
SRC="${SOURCE_PATH%/}/"
DEST="${DEST_PATH%/}/"
OUT=/logs/agent/agent-output.txt

aws s3 mv "$SRC" "$DEST" --recursive --region "$REGION"
aws s3 rm "$DEST" --recursive --exclude "*" --include "*2022*" --include "*2023*" --region "$REGION"
mkdir -p "$(dirname "$OUT")" && echo "Done." > "$OUT"
