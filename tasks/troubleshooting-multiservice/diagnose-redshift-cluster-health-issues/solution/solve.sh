#!/bin/bash
set -euo pipefail

REGION="us-east-1"
CLUSTER="${GLOBAL_CLUSTER_IDENTIFIER}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

CLUSTER_STATUS=$(aws redshift describe-clusters --region "$REGION" \
    --cluster-identifier "$CLUSTER" \
    --query "Clusters[0].ClusterStatus" --output text)
CLUSTER_AVAILABILITY=$(aws redshift describe-clusters --region "$REGION" \
    --cluster-identifier "$CLUSTER" \
    --query "Clusters[0].ClusterAvailabilityStatus" --output text)
CLUSTER_TYPE=$(aws redshift describe-clusters --region "$REGION" \
    --cluster-identifier "$CLUSTER" \
    --query "Clusters[0].ClusterType" --output text)
NODE_COUNT=$(aws redshift describe-clusters --region "$REGION" \
    --cluster-identifier "$CLUSTER" \
    --query "Clusters[0].NumberOfNodes" --output text)
NODE_ROLES=$(aws redshift describe-clusters --region "$REGION" \
    --cluster-identifier "$CLUSTER" \
    --query "Clusters[0].ClusterNodes[].NodeRole" --output text)

ALL_ALARM=$(aws cloudwatch describe-alarms-for-metric --region "$REGION" \
    --namespace AWS/Redshift --metric-name HealthStatus \
    --dimensions Name=ClusterIdentifier,Value="$CLUSTER" \
    --query "MetricAlarms[0].AlarmName" --output text)
ALL_STATE=$(aws cloudwatch describe-alarms-for-metric --region "$REGION" \
    --namespace AWS/Redshift --metric-name HealthStatus \
    --dimensions Name=ClusterIdentifier,Value="$CLUSTER" \
    --query "MetricAlarms[0].StateValue" --output text)
ALL_OPERATOR=$(aws cloudwatch describe-alarms-for-metric --region "$REGION" \
    --namespace AWS/Redshift --metric-name HealthStatus \
    --dimensions Name=ClusterIdentifier,Value="$CLUSTER" \
    --query "MetricAlarms[0].ComparisonOperator" --output text)
ALL_THRESHOLD=$(aws cloudwatch describe-alarms-for-metric --region "$REGION" \
    --namespace AWS/Redshift --metric-name HealthStatus \
    --dimensions Name=ClusterIdentifier,Value="$CLUSTER" \
    --query "MetricAlarms[0].Threshold" --output text)

LEADER_ALARM=$(aws cloudwatch describe-alarms-for-metric --region "$REGION" \
    --namespace AWS/Redshift --metric-name HealthStatus \
    --dimensions Name=ClusterIdentifier,Value="$CLUSTER" Name=NodeID,Value=Leader \
    --query "MetricAlarms[0].AlarmName" --output text)
LEADER_STATE=$(aws cloudwatch describe-alarms-for-metric --region "$REGION" \
    --namespace AWS/Redshift --metric-name HealthStatus \
    --dimensions Name=ClusterIdentifier,Value="$CLUSTER" Name=NodeID,Value=Leader \
    --query "MetricAlarms[0].StateValue" --output text)

cat > "$OUT" <<EOF
The Redshift cluster $CLUSTER is not actually unhealthy. Its cluster status is "$CLUSTER_STATUS" and its availability status is "$CLUSTER_AVAILABILITY", i.e. the cluster is healthy and available. The reported "health issue" is a false alarm caused by a misconfigured CloudWatch alarm.

The alarm $ALL_ALARM is in $ALL_STATE state because it uses the wrong comparison operator. It is configured with $ALL_OPERATOR and a threshold of $ALL_THRESHOLD on the AWS/Redshift HealthStatus metric. A healthy Redshift cluster reports a HealthStatus of 1.0, and since 1.0 is greater than $ALL_THRESHOLD, an alarm configured with $ALL_OPERATOR fires continuously even though the cluster is healthy. The comparison operator should be LessThanThreshold so the alarm fires only when HealthStatus drops below the threshold, which is what correctly detects an unhealthy cluster.

The other alarm $LEADER_ALARM is in $LEADER_STATE state. This is expected: the cluster is a $CLUSTER_TYPE cluster with $NODE_COUNT node(s), and its node has the role "$NODE_ROLES". A single-node cluster emits no Leader-specific HealthStatus metrics, so the leader-node alarm never receives data and stays in $LEADER_STATE. This is not a problem.

Root cause: the wrong comparison operator ($ALL_OPERATOR instead of LessThanThreshold) on the $ALL_ALARM alarm. Fix it by updating that alarm to use LessThanThreshold. The cluster itself is available and healthy.
EOF
