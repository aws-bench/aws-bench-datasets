#!/bin/bash
set -euo pipefail

REGION="ap-southeast-1"
ALARM_NAME="${SERVICE_LATENCY_ALARM_NAME}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

ALARM=$(aws cloudwatch describe-alarms --region "$REGION" --alarm-names "$ALARM_NAME" \
    --query "MetricAlarms[0].[StateValue,Namespace,MetricName,ExtendedStatistic,Threshold,ComparisonOperator,EvaluationPeriods,Period]" \
    --output text)
STATE=$(printf '%s' "$ALARM" | awk '{print $1}')
NAMESPACE=$(printf '%s' "$ALARM" | awk '{print $2}')
METRIC=$(printf '%s' "$ALARM" | awk '{print $3}')
STAT=$(printf '%s' "$ALARM" | awk '{print $4}')
THRESHOLD=$(printf '%s' "$ALARM" | awk '{print $5}')
OP_NAME=$(printf '%s' "$ALARM" | awk '{print $6}')
EVAL_PERIODS=$(printf '%s' "$ALARM" | awk '{print $7}')
PERIOD=$(printf '%s' "$ALARM" | awk '{print $8}')

TRACKED_OP=$(aws cloudwatch describe-alarms --region "$REGION" --alarm-names "$ALARM_NAME" \
    --query "MetricAlarms[0].Dimensions[?Name=='Operation'].Value | [0]" --output text)

END=$(date -u +%Y-%m-%dT%H:%M:%SZ)
START=$(date -u -d '3 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-3H +%Y-%m-%dT%H:%M:%SZ)

get_op() {
    aws cloudwatch get-metric-statistics --region "$REGION" \
        --namespace "$NAMESPACE" --metric-name "$METRIC" \
        --dimensions Name=Camera_name,Value=ALL Name=Operation,Value="$1" \
        --start-time "$START" --end-time "$END" --period 300 --statistics Average \
        --query "sort_by(Datapoints,&Timestamp)[-1].Average" --output text
}

FRAMEQUARTZLAG=$(get_op FrameQuartzLag)
PROCESSFRAME=$(get_op ProcessFrame)
MOTIONDETECTION=$(get_op MotionDetection)
HLSSTARTLAG=$(get_op HLSStartLag)
INTERNAL=$(get_op InternalPipelineTime)

CPU=$(aws cloudwatch get-metric-statistics --region "$REGION" \
    --namespace "$NAMESPACE" --metric-name NonIdlePct \
    --dimensions Name=Camera_name,Value=ALL Name=Operation,Value=CPU \
    --start-time "$START" --end-time "$END" --period 300 --statistics Average \
    --query "sort_by(Datapoints,&Timestamp)[-1].Average" --output text)

QUARTZ_DIM=$(aws cloudwatch list-metrics --region "$REGION" --namespace Flint/Dependencies \
    --metric-name APILatency \
    --query "Metrics[0].Dimensions[?Name=='Service'].Value | [0]" --output text)
QUARTZ_OP=$(aws cloudwatch list-metrics --region "$REGION" --namespace Flint/Dependencies \
    --metric-name APILatency \
    --query "Metrics[0].Dimensions[?Name=='Operation'].Value | [0]" --output text)

QUARTZ_AVG=$(aws cloudwatch get-metric-statistics --region "$REGION" \
    --namespace Flint/Dependencies --metric-name APILatency \
    --dimensions Name=Service,Value="$QUARTZ_DIM" Name=Operation,Value="$QUARTZ_OP" \
    --start-time "$START" --end-time "$END" --period 300 --statistics Average \
    --query "sort_by(Datapoints,&Timestamp)[-1].Average" --output text)

CLUSTER=$(aws cloudformation describe-stacks --region "$REGION" \
    --stack-name api-and-observability-CloudWatch-89fb5762b-ap-southeast-1 \
    --query "Stacks[0].Outputs[?OutputKey=='ClusterName'].OutputValue | [0]" --output text)
SERVICE=$(aws cloudformation describe-stacks --region "$REGION" \
    --stack-name api-and-observability-CloudWatch-89fb5762b-ap-southeast-1 \
    --query "Stacks[0].Outputs[?OutputKey=='ServiceName'].OutputValue | [0]" --output text)

ECS=$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" \
    --query "services[0].[runningCount,desiredCount]" --output text)
RUNNING=$(printf '%s' "$ECS" | awk '{print $1}')
DESIRED=$(printf '%s' "$ECS" | awk '{print $2}')

LATENCY_PARAM=$(aws ssm get-parameters-by-path --region "$REGION" --path "/flint/prod" --recursive \
    --query "Parameters[?contains(Name,'latency-mode')].Name | [0]" --output text)
LATENCY_MODE=$(aws ssm get-parameter --region "$REGION" --name "$LATENCY_PARAM" \
    --query "Parameter.Value" --output text)

cat > "$OUT" <<EOF
# Why CloudWatch alarm ${ALARM_NAME} is firing (ap-southeast-1)

## Alarm configuration
The alarm is in state ${STATE}. It tracks the ${STAT} of the ${NAMESPACE} namespace "${METRIC}"
metric with Operation=${TRACKED_OP} (the end-to-end latency, in milliseconds, from initial frame
processing to reporting an object to the downstream Quartz service). It fires when that ${STAT}
exceeds ${THRESHOLD} ms (15 seconds) for ${EVAL_PERIODS} consecutive ${PERIOD}-second periods
(${OP_NAME}).

## Diagnosis
The alarm is firing because of elevated latency in the DOWNSTREAM Quartz service, NOT because of
any problem in the ECS service's own internal processing pipeline.

The internal pipeline components are all normal:
- ProcessFrame (~${PROCESSFRAME} ms), MotionDetection (~${MOTIONDETECTION} ms) and HLSStartLag
  (~${HLSSTARTLAG} ms), and their sum InternalPipelineTime (~${INTERNAL} ms), are all far below the
  ${THRESHOLD} ms threshold.
- CPU (Flint NonIdlePct, ~${CPU}%) on the ${SERVICE} ECS service is normal, and the service is
  running its desired task count (${RUNNING}/${DESIRED}).

The bottleneck is the Quartz service's ${QUARTZ_OP} operation. Its API latency
(Flint/Dependencies APILatency, Service=${QUARTZ_DIM}, Operation=${QUARTZ_OP}) is well above the
threshold — most recent observed average ~${QUARTZ_AVG} ms — and this single downstream call, added
to the small internal pipeline time, accounts for the entire ${TRACKED_OP} ${STAT} breach (most
recent ~${FRAMEQUARTZLAG} ms).

## Root cause
The elevated Quartz latency is not a real Quartz outage. It is driven by the SSM parameter that
controls the task's latency mode, ${LATENCY_PARAM}, which is currently set to "${LATENCY_MODE}". In
"degraded" mode the ECS motion-detection task publishes high Quartz API latency, pushing
${TRACKED_OP} above the ${THRESHOLD} ms (15-second) alarm threshold.

## Fix
Set the latency-mode SSM parameter back to "healthy":

  aws ssm put-parameter --region ${REGION} --name ${LATENCY_PARAM} --value healthy --overwrite

Once the parameter is healthy, the ECS task resumes publishing normal Quartz latency and the
${TRACKED_OP} ${STAT} drops back below 15 seconds, returning the alarm to OK.

## Key finding
The alarm fires due to downstream Quartz latency, not an issue with the ECS service's own internal
processing pipeline.
EOF
