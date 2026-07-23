#!/bin/bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
CLUSTER="${CLUSTER_NAME}"
ADDON="aws-efs-csi-driver"
CONFIG='{"useFIPS": true}'
OUT=/logs/agent/agent-output.txt

aws eks create-addon --cluster-name "$CLUSTER" --addon-name "$ADDON" \
  --configuration-values "$CONFIG" --resolve-conflicts OVERWRITE --region "$REGION"

mkdir -p "$(dirname "$OUT")" && echo "Done." > "$OUT"
