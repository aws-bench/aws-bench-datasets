#!/bin/bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
HIERARCHY_NAME="${HIERARCHY_NAME:-Turbines}"
OUT=/logs/agent/agent-output.txt

CHILD_PROPS=$(printf '[{"name":"ActivePower","dataType":"DOUBLE","type":{"measurement":{}}},{"name":"ActivePowerAvg","dataType":"DOUBLE","type":{"metric":{"expression":"avg(ap)","variables":[{"name":"ap","value":{"propertyId":"ActivePower"}}],"window":{"tumbling":{"interval":"5m"}}}}}]')

CHILD_ID=$(aws iotsitewise create-asset-model --region "$REGION" \
  --asset-model-name WindTurbineModel \
  --asset-model-properties "$CHILD_PROPS" \
  --query 'assetModelId' --output text)

aws iotsitewise wait asset-model-active --region "$REGION" --asset-model-id "$CHILD_ID"

CHILD_AVG_ID=$(aws iotsitewise describe-asset-model --region "$REGION" \
  --asset-model-id "$CHILD_ID" \
  --query "assetModelProperties[?name=='ActivePowerAvg'].id | [0]" --output text)

PARENT_PROPS=$(printf '[{"name":"TotalActivePower","dataType":"DOUBLE","type":{"measurement":{}}},{"name":"FleetAverageActivePower","dataType":"DOUBLE","type":{"metric":{"expression":"avg(power)","variables":[{"name":"power","value":{"propertyId":"%s","hierarchyId":"%s"}}],"window":{"tumbling":{"interval":"5m"}}}}}]' "$CHILD_AVG_ID" "$HIERARCHY_NAME")

PARENT_HIER=$(printf '[{"name":"%s","childAssetModelId":"%s"}]' "$HIERARCHY_NAME" "$CHILD_ID")

PARENT_ID=$(aws iotsitewise create-asset-model --region "$REGION" \
  --asset-model-name WindFarmModel \
  --asset-model-properties "$PARENT_PROPS" \
  --asset-model-hierarchies "$PARENT_HIER" \
  --query 'assetModelId' --output text)

mkdir -p "$(dirname "$OUT")"
printf 'Created WindTurbineModel (%s) and WindFarmModel (%s) with a Turbines hierarchy and a FleetAverageActivePower rollup metric averaging ActivePower over a 5-minute tumbling window.\n' "$CHILD_ID" "$PARENT_ID" > "$OUT"
