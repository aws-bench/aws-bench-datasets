#!/bin/bash
set -euo pipefail

REGION="eu-west-1"
CLUSTER_ID="${EMR_CLUSTER_ID}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

# Check for submitted steps
STEP_COUNT=$(aws emr list-steps --region "$REGION" --cluster-id "$CLUSTER_ID" \
    --query "length(Steps)" --output text)

# Get Spark configuration
SPARK_DEFAULTS=$(aws emr describe-cluster --region "$REGION" --cluster-id "$CLUSTER_ID" \
    --query "Cluster.Configurations[?Classification=='spark-defaults'].Properties" --output json)

EXECUTOR_INSTANCES=$(echo "$SPARK_DEFAULTS" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["spark.executor.instances"])')
EXECUTOR_MEMORY=$(echo "$SPARK_DEFAULTS" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["spark.executor.memory"])')
MEMORY_OVERHEAD=$(echo "$SPARK_DEFAULTS" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["spark.yarn.executor.memoryOverhead"])')
DRIVER_MEMORY=$(echo "$SPARK_DEFAULTS" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["spark.driver.memory"])')
DYN_ALLOC=$(echo "$SPARK_DEFAULTS" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["spark.dynamicAllocation.enabled"])')
SHUFFLE_PARTITIONS=$(echo "$SPARK_DEFAULTS" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["spark.sql.shuffle.partitions"])')

# Get core fleet sizing
CORE_TARGET=$(aws emr list-instance-fleets --region "$REGION" --cluster-id "$CLUSTER_ID" \
    --query "InstanceFleets[?InstanceFleetType=='CORE'].TargetOnDemandCapacity | [0]" --output text)
CORE_TYPE=$(aws emr list-instance-fleets --region "$REGION" --cluster-id "$CLUSTER_ID" \
    --query "InstanceFleets[?InstanceFleetType=='CORE'].InstanceTypeSpecifications[0].InstanceType | [0]" --output text)

CORE_MEM_MIB=$(aws ec2 describe-instance-types --region "$REGION" --instance-types "$CORE_TYPE" \
    --query "InstanceTypes[0].MemoryInfo.SizeInMiB" --output text)

PER_EXECUTOR_GB=$(( ${EXECUTOR_MEMORY%[Gg]} + ${MEMORY_OVERHEAD%[Gg]} ))
CORE_MEM_GB=$(( CORE_MEM_MIB / 1024 ))
UNALLOCATED=$(( EXECUTOR_INSTANCES - CORE_TARGET ))

cat > "$OUT" <<EOF
No Spark steps have been submitted to cluster ${CLUSTER_ID} (${STEP_COUNT} steps found). However, the spark-defaults configuration has several critical problems that would prevent or severely degrade any submitted job:

1. Oversized driver memory: spark.driver.memory is set to ${DRIVER_MEMORY}, which exceeds the total memory of a ${CORE_TYPE} instance (${CORE_MEM_GB} GB). This would prevent the driver from launching at all.

2. Severe executor overallocation: spark.executor.instances is set to ${EXECUTOR_INSTANCES}, with spark.executor.memory of ${EXECUTOR_MEMORY} and spark.yarn.executor.memoryOverhead of ${MEMORY_OVERHEAD} (${PER_EXECUTOR_GB} GB per executor). The core instance fleet targets only ${CORE_TARGET} ${CORE_TYPE} instance (${CORE_MEM_GB} GB), so YARN could provision at most ${CORE_TARGET} executor. The remaining ${UNALLOCATED} requested executors would never be allocated, leaving the vast majority of Spark tasks waiting indefinitely.

3. Dynamic allocation disabled: spark.dynamicAllocation.enabled is ${DYN_ALLOC}, so Spark cannot scale the executor count down to match actual cluster capacity.

4. Excessive shuffle partitions: spark.sql.shuffle.partitions is set to ${SHUFFLE_PARTITIONS}, which adds unnecessary scheduling overhead relative to the ${CORE_TARGET} available executor.

To fix: reduce spark.driver.memory below ${CORE_MEM_GB}G, set spark.executor.instances to match the core fleet capacity (or enable dynamic allocation by setting spark.dynamicAllocation.enabled to true), and reduce spark.sql.shuffle.partitions — or scale the core instance fleet up to provide the requested executor capacity.
EOF
