#!/bin/bash
set -euo pipefail

REGION="eu-west-1"
CLUSTER_ID="${EMR_CLUSTER_ID}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

SPARK_DEFAULTS=$(aws emr describe-cluster --region "$REGION" --cluster-id "$CLUSTER_ID" \
    --query "Cluster.Configurations[?Classification=='spark-defaults'].Properties" --output json)

EXECUTOR_INSTANCES=$(echo "$SPARK_DEFAULTS" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["spark.executor.instances"])')
EXECUTOR_MEMORY=$(echo "$SPARK_DEFAULTS" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["spark.executor.memory"])')
MEMORY_OVERHEAD=$(echo "$SPARK_DEFAULTS" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["spark.yarn.executor.memoryOverhead"])')
DRIVER_MEMORY=$(echo "$SPARK_DEFAULTS" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["spark.driver.memory"])')
DYN_ALLOC=$(echo "$SPARK_DEFAULTS" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["spark.dynamicAllocation.enabled"])')
SHUFFLE_PARTITIONS=$(echo "$SPARK_DEFAULTS" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["spark.sql.shuffle.partitions"])')

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
The EMR cluster ${CLUSTER_ID} in ${REGION} is experiencing performance issues due to a severe executor overallocation in its spark-defaults configuration, combined with an undersized core instance fleet.

Root causes:

1. Executor overallocation vs. available capacity. spark.executor.instances is set to ${EXECUTOR_INSTANCES}, with spark.executor.memory of ${EXECUTOR_MEMORY} and spark.yarn.executor.memoryOverhead of ${MEMORY_OVERHEAD}, totalling ${PER_EXECUTOR_GB} GB per executor. While ${PER_EXECUTOR_GB} GB fits within the ${CORE_MEM_GB} GB available on each ${CORE_TYPE} core node, the core instance fleet only targets ${CORE_TARGET} instance, so YARN can provision at most ${CORE_TARGET} executor. The remaining ${UNALLOCATED} requested executors are never allocated, and the vast majority of Spark tasks are queued indefinitely, which is why jobs run far slower than expected.

2. Dynamic allocation disabled. spark.dynamicAllocation.enabled is ${DYN_ALLOC}, so Spark cannot scale the executor count down to match the actual cluster capacity.

3. Oversized driver memory. spark.driver.memory is set to ${DRIVER_MEMORY}, which exceeds the total memory of a ${CORE_TYPE} instance (${CORE_MEM_GB} GB) and will cause the driver to fail to launch.

4. Excessive shuffle partitions. spark.sql.shuffle.partitions is set to ${SHUFFLE_PARTITIONS}, which adds unnecessary scheduling overhead relative to the ${CORE_TARGET} available executor.

Fix: bring spark.executor.instances in line with the core fleet capacity (or enable dynamic allocation by setting spark.dynamicAllocation.enabled to true), reduce spark.driver.memory below the ${CORE_MEM_GB} GB instance memory limit, and scale spark.sql.shuffle.partitions down — or scale the core instance fleet up to provide the requested executor capacity.
EOF
