#!/bin/bash
set -euo pipefail

REGION="us-east-1"
ALARM_NAME="${ALARM_NAME}"
SERVER_ID="${SERVER_ID}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

METRIC_NAME=$(aws cloudwatch describe-alarms --alarm-names "$ALARM_NAME" --region "$REGION" \
    --query "MetricAlarms[0].MetricName" --output text)
NAMESPACE=$(aws cloudwatch describe-alarms --alarm-names "$ALARM_NAME" --region "$REGION" \
    --query "MetricAlarms[0].Namespace" --output text)
STATISTIC=$(aws cloudwatch describe-alarms --alarm-names "$ALARM_NAME" --region "$REGION" \
    --query "MetricAlarms[0].Statistic" --output text)
THRESHOLD=$(aws cloudwatch describe-alarms --alarm-names "$ALARM_NAME" --region "$REGION" \
    --query "MetricAlarms[0].Threshold" --output text)
COMPARISON=$(aws cloudwatch describe-alarms --alarm-names "$ALARM_NAME" --region "$REGION" \
    --query "MetricAlarms[0].ComparisonOperator" --output text)
TREAT_MISSING=$(aws cloudwatch describe-alarms --alarm-names "$ALARM_NAME" --region "$REGION" \
    --query "MetricAlarms[0].TreatMissingData" --output text)
ALARM_ACTIONS=$(aws cloudwatch describe-alarms --alarm-names "$ALARM_NAME" --region "$REGION" \
    --query "MetricAlarms[0].AlarmActions" --output json)

LOG_GROUP_NAME=$(aws logs describe-metric-filters --metric-name "$METRIC_NAME" \
    --metric-namespace "$NAMESPACE" --region "$REGION" \
    --query "metricFilters[0].logGroupName" --output text)
FILTER_PATTERN=$(aws logs describe-metric-filters --metric-name "$METRIC_NAME" \
    --metric-namespace "$NAMESPACE" --region "$REGION" \
    --query "metricFilters[0].filterPattern" --output text)

LOGGING_ROLE=$(aws transfer describe-server --server-id "$SERVER_ID" --region "$REGION" \
    --query "Server.LoggingRole" --output text)
STRUCTURED_DEST=$(aws transfer describe-server --server-id "$SERVER_ID" --region "$REGION" \
    --query "Server.StructuredLogDestinations" --output json)

SERVICE_LOG_GROUP="/aws/transfer/${SERVER_ID}"

cat > "$OUT" <<EOF
The alarm ${ALARM_NAME} watches a custom metric ${METRIC_NAME} (namespace ${NAMESPACE})
that a metric filter on log group ${LOG_GROUP_NAME} increments on the literal string
"${FILTER_PATTERN}"; it triggers on ${STATISTIC} ${COMPARISON} ${THRESHOLD} with
TreatMissingData=${TREAT_MISSING}. It never fires because that log group receives no data.

The Transfer server ${SERVER_ID} uses a legacy loggingRole (${LOGGING_ROLE}) with no
structuredLogDestinations (StructuredLogDestinations=${STRUCTURED_DEST}), so AWS Transfer
Family logs to the service-managed group ${SERVICE_LOG_GROUP}, not ${LOG_GROUP_NAME}.
With nothing published to ${METRIC_NAME}, the alarm stays in INSUFFICIENT_DATA (treated
as OK because of ${TREAT_MISSING}) and cannot reach ALARM from real errors.

Even if it did fire, no one would be notified: AlarmActions is empty (${ALARM_ACTIONS}).

Fix: route the server's logs to ${LOG_GROUP_NAME} (add structuredLogDestinations, or
repoint the metric filter to ${SERVICE_LOG_GROUP}) so ERROR events increment ${METRIC_NAME},
and add an SNS topic ARN to AlarmActions.
EOF
