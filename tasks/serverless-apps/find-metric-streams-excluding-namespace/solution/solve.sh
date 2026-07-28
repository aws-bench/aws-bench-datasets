#!/bin/bash
set -euo pipefail

OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

REGIONS=$(printf '%s' "${ALLOWED_REGIONS}" | tr ',' ' ')

STREAM_NAME=""
NAMESPACE=""
METRICS=""

for REGION in $REGIONS; do
    for NAME in $(aws cloudwatch list-metric-streams --region "$REGION" --query 'Entries[].Name' --output text); do
        NS=$(aws cloudwatch get-metric-stream --name "$NAME" --region "$REGION" \
            --query "ExcludeFilters[0].Namespace" --output text)
        if [ "$NS" != "None" ]; then
            STREAM_NAME="$NAME"
            NAMESPACE="$NS"
            METRICS=$(aws cloudwatch get-metric-stream --name "$NAME" --region "$REGION" \
                --query "ExcludeFilters[0].MetricNames" --output text | sed 's/\t/, /g')
        fi
    done
done

cat > "$OUT" <<EOF
Yes, the metric stream ${STREAM_NAME} excludes the metrics ${METRICS} from the ${NAMESPACE} namespace.
EOF
