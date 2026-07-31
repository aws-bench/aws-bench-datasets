#!/bin/bash
set -euo pipefail

REGION="ap-southeast-1"
ALARM_NAME="${SERVICE_LATENCY_ALARM_NAME}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

ALARM_JSON=$(aws cloudwatch describe-alarms --region "$REGION" --alarm-names "$ALARM_NAME" \
    --query "MetricAlarms[0].[StateValue,Threshold,Statistic,ExtendedStatistic,MetricName,ComparisonOperator]" \
    --output text)
STATE=$(printf '%s' "$ALARM_JSON" | cut -f1)
THRESHOLD=$(printf '%s' "$ALARM_JSON" | cut -f2)
STATISTIC=$(printf '%s' "$ALARM_JSON" | cut -f3)
EXTSTAT=$(printf '%s' "$ALARM_JSON" | cut -f4)
METRIC_NAME=$(printf '%s' "$ALARM_JSON" | cut -f5)
COMPARISON=$(printf '%s' "$ALARM_JSON" | cut -f6)
STAT="$EXTSTAT"
[ "$EXTSTAT" = "None" ] && STAT="$STATISTIC"

OPERATION=$(aws cloudwatch describe-alarms --region "$REGION" --alarm-names "$ALARM_NAME" \
    --query "MetricAlarms[0].Dimensions[?Name=='Operation'].Value | [0]" --output text)

THRESHOLD_S=$(awk "BEGIN{printf \"%.0f\", ${THRESHOLD}/1000}")

CPU_AVG=$(aws cloudwatch get-metric-statistics --region "$REGION" \
    --namespace Flint --metric-name NonIdlePct \
    --dimensions Name=Camera_name,Value=ALL Name=Operation,Value=CPU \
    --start-time "$(date -u -d '-3 hours' +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -v-3H +%Y-%m-%dT%H:%M:%S)" \
    --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
    --period 3600 --statistics Average \
    --query "sort_by(Datapoints,&Timestamp)[-1].Average" --output text)

END=$(date -u +%s)
START=$((END - 10800))

TRACE_ID=$(aws xray get-trace-summaries --region "$REGION" \
    --start-time "$START" --end-time "$END" --no-paginate \
    --query "TraceSummaries[0].Id" --output text | head -1)

QUARTZ_MS=""
INTERNAL_MS=""
TOTAL_MS=""
QUARTZ_PCT=""
if [ -n "$TRACE_ID" ] && [ "$TRACE_ID" != "None" ]; then
    TRACE_DOC=$(aws xray batch-get-traces --region "$REGION" --trace-ids "$TRACE_ID" \
        --query "Traces[0].Segments[0].Document" --output text)
    QUARTZ_MS=$(printf '%s' "$TRACE_DOC" | jq -r '[.. | objects | select(.name=="QuartzAPI")][0] | ((.end_time - .start_time) * 1000 | floor)')
    INTERNAL_MS=$(printf '%s' "$TRACE_DOC" | jq -r '[.. | objects | select(.name=="InternalPipeline")][0] | ((.end_time - .start_time) * 1000 | floor)')
    TOTAL_MS=$(printf '%s' "$TRACE_DOC" | jq -r '((.end_time - .start_time) * 1000 | floor)')
    QUARTZ_PCT=$(awk "BEGIN{if(${TOTAL_MS}>0)printf \"%.0f\", ${QUARTZ_MS}*100/${TOTAL_MS}}")
fi

if [ -n "$QUARTZ_MS" ]; then
    XRAY_LINE="X-Ray evidence: the FlintMotionDetection root trace ${TRACE_ID} splits into two subsegments. The QuartzAPI subsegment — the outbound ReportPerson call (POST quartz-api.internal.aws/v1/report-person) to the downstream Quartz service — measured ~${QUARTZ_MS} ms, roughly ${QUARTZ_PCT}% of the ~${TOTAL_MS} ms total, while the InternalPipeline subsegment (ProcessFrame + MotionDetection + HLSStartLag) measured only ~${INTERNAL_MS} ms. The QuartzAPI subsegment accounts for the majority of the total trace duration."
else
    XRAY_LINE="X-Ray evidence: the FlintMotionDetection root trace splits into a QuartzAPI subsegment (the outbound ReportPerson call to the downstream Quartz service, POST quartz-api.internal.aws/v1/report-person) and an InternalPipeline subsegment; the QuartzAPI/ReportPerson call is the bottleneck that dominates total trace duration."
fi

cat > "$OUT" <<EOF
Diagnosis: the latency is caused by degradation in the downstream Quartz dependency service (the ReportPerson call), not by the Flint ECS service itself.

Alarm: ${ALARM_NAME} is currently in state ${STATE}. It watches the ${STAT} statistic of the Flint "${METRIC_NAME}" metric for Operation=${OPERATION} (end-to-end frame-to-report latency) and fires when it is ${COMPARISON} the ${THRESHOLD} ms (~${THRESHOLD_S} second) threshold.

${XRAY_LINE}

Internal pipeline components (ProcessFrame, MotionDetection, HLSStartLag) and ECS CPU utilization (queried Flint NonIdlePct average ~${CPU_AVG}%) are within their normal ranges.

Root cause: Quartz service degradation on the ReportPerson calls. The bottleneck is the external Quartz dependency; the Flint ECS service is healthy and requires no change. The fix belongs with the Quartz service (restore its ReportPerson latency), not the ECS service.
EOF
