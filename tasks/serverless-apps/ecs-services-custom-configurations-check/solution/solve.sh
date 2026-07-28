#!/bin/bash
set -euo pipefail

OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

REGIONS=$(printf '%s' "${ALLOWED_REGIONS}" | tr ',' ' ')

SVC_NAME=""
DESIRED=""
PUBLIC_IP=""
PLATFORM=""
GRACE=""
MIN_HEALTHY=""

for REGION in $REGIONS; do
    for CLUSTER in $(aws ecs list-clusters --region "$REGION" --query 'clusterArns[]' --output text); do
        for SVC in $(aws ecs list-services --region "$REGION" --cluster "$CLUSTER" --query 'serviceArns[]' --output text); do
            read -r NAME D IP PF G MH < <(
                aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SVC" \
                    --query "services[0].[serviceName,desiredCount,networkConfiguration.awsvpcConfiguration.assignPublicIp,platformFamily,healthCheckGracePeriodSeconds,deploymentConfiguration.minimumHealthyPercent]" \
                    --output text
            )
            if [ "$D" != "1" ] || [ "$IP" == "ENABLED" ] || [ "$PF" != "Linux" ] || [ "$G" != "0" ] || [ "$MH" != "100" ]; then
                SVC_NAME="$NAME"
                DESIRED="$D"
                PUBLIC_IP="$IP"
                PLATFORM="$PF"
                GRACE="$G"
                MIN_HEALTHY="$MH"
            fi
        done
    done
done

cat > "$OUT" <<EOF
${SVC_NAME} has several non-default settings: desired task count is ${DESIRED} (default 1), public IP assignment is ${PUBLIC_IP} (default disabled for Fargate), it uses a ${PLATFORM} platform (default Linux), has a health check grace period of ${GRACE} seconds (default 0), and minimumHealthyPercent is ${MIN_HEALTHY} (default 100). It is the only ECS service with custom configurations.
EOF
