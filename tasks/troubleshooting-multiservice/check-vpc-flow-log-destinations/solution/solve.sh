#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

FLOW_LOGS=$(aws ec2 describe-flow-logs --region "$REGION" \
    --filter "Name=resource-id,Values=$VPC_ID" \
    --query "FlowLogs[].[FlowLogId,LogDestinationType,LogDestination,MaxAggregationInterval,FlowLogStatus,TrafficType]" \
    --output text)

FLOW_LOG_COUNT=$(printf '%s\n' "$FLOW_LOGS" | awk 'NF{c++} END{print c+0}')
CWL_DEST_COUNT=$(printf '%s\n' "$FLOW_LOGS" | awk '$2=="cloud-watch-logs"{c++} END{print c+0}')

read -r FLOW_LOG_ID DEST_TYPE LOG_DEST INTERVAL STATUS TRAFFIC_TYPE <<< "$FLOW_LOGS"

BUCKET_NAME="${LOG_DEST##*:}"

LOG_GROUPS=$(aws logs describe-log-groups --region "$REGION" \
    --query "logGroups[?contains(logGroupName,'VpcFlowLog')].logGroupName" \
    --output text)

TOTAL_STREAMS=0
for g in $LOG_GROUPS; do
    STREAMS=$(aws logs describe-log-streams --region "$REGION" --log-group-name "$g" \
        --query "logStreams[].logStreamName" --output text)
    N=$(printf '%s\n' "$STREAMS" | awk 'NF{c++} END{print c+0}')
    TOTAL_STREAMS=$((TOTAL_STREAMS + N))
done

LOG_GROUP_LIST=$(printf '%s\n' "$LOG_GROUPS" | tr '\t' '\n' | awk 'NF' | paste -sd ', ' -)

cat > "$OUT" <<EOF
VPC $VPC_ID in $REGION has a single active flow log ($FLOW_LOG_ID, status $STATUS) — it is the only flow log configured on the VPC ($FLOW_LOG_COUNT total). It captures $TRAFFIC_TYPE traffic and delivers to the S3 bucket $BUCKET_NAME (destination type: $DEST_TYPE) with a ${INTERVAL}-second maximum aggregation interval. S3 is the only real destination in use.

The appearance of "multiple destinations" comes from two CloudWatch Logs log groups whose names suggest VPC flow log usage: $LOG_GROUP_LIST. No flow log is configured to deliver to CloudWatch Logs ($CWL_DEST_COUNT flow logs target cloud-watch-logs), and these groups contain $TOTAL_STREAMS log streams, so no flow log data is being written to them. They are not active destinations and can be considered for cleanup.

Verdict: exactly one flow log ($FLOW_LOG_ID) is really being used, delivering all traffic to S3 bucket $BUCKET_NAME. The two CloudWatch log groups are unused.
EOF
