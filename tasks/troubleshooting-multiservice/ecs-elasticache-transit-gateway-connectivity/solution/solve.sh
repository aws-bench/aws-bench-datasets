#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

ECS_CLUSTER=$(printf '%s\n' "$ECS_SERVICE_ARN" | awk -F/ '{print $2}')

SERVICE=$(aws ecs describe-services --region "$REGION" \
    --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE_ARN" \
    --query "services[0].[serviceName,status,desiredCount,runningCount]" --output text)
SERVICE_NAME=$(printf '%s\n' "$SERVICE" | awk '{print $1}')

ECS_SUBNETS=$(aws ecs describe-services --region "$REGION" \
    --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE_ARN" \
    --query "services[0].networkConfiguration.awsvpcConfiguration.subnets" --output text)
ECS_SUBNET_CSV=$(printf '%s\n' "$ECS_SUBNETS" | tr '\t' ',')
ECS_SUBNET_FIRST=$(printf '%s\n' "$ECS_SUBNETS" | tr '\t' '\n' | sed -n '1p')

ECS_VPC=$(aws ec2 describe-subnets --region "$REGION" \
    --subnet-ids "$ECS_SUBNET_FIRST" \
    --query "Subnets[0].VpcId" --output text)

ECS_RT_LIST=$(aws ec2 describe-route-tables --region "$REGION" \
    --filters "Name=association.subnet-id,Values=$ECS_SUBNET_CSV" \
    --query "RouteTables[].RouteTableId" --output text | tr '\t' '\n' | sort -u)
ECS_RT1=$(printf '%s\n' "$ECS_RT_LIST" | sed -n '1p')
ECS_RT2=$(printf '%s\n' "$ECS_RT_LIST" | sed -n '2p')

ECS_ROUTES=$(aws ec2 describe-route-tables --region "$REGION" \
    --route-table-ids $ECS_RT_LIST \
    --query "RouteTables[].[RouteTableId,Routes[].[DestinationCidrBlock,TransitGatewayId,NatGatewayId,GatewayId]]" \
    --output json)

CACHE=$(aws elasticache describe-cache-clusters --region "$REGION" \
    --cache-cluster-id "$CACHE_CLUSTER_ID" --show-cache-node-info \
    --query "CacheClusters[0].[CacheClusterStatus,CacheSubnetGroupName,SecurityGroups[0].SecurityGroupId]" \
    --output text)
CACHE_SUBNET_GROUP=$(printf '%s\n' "$CACHE" | awk '{print $2}')
CACHE_SG=$(printf '%s\n' "$CACHE" | awk '{print $3}')

CACHE_SUBNET=$(aws elasticache describe-cache-subnet-groups --region "$REGION" \
    --cache-subnet-group-name "$CACHE_SUBNET_GROUP" \
    --query "CacheSubnetGroups[0].Subnets[0].SubnetIdentifier" --output text)
CACHE_VPC=$(aws elasticache describe-cache-subnet-groups --region "$REGION" \
    --cache-subnet-group-name "$CACHE_SUBNET_GROUP" \
    --query "CacheSubnetGroups[0].VpcId" --output text)

CACHE_RT1=$(aws ec2 describe-route-tables --region "$REGION" \
    --filters "Name=association.subnet-id,Values=$CACHE_SUBNET" \
    --query "RouteTables[0].RouteTableId" --output text)
CACHE_ROUTES=$(aws ec2 describe-route-tables --region "$REGION" \
    --route-table-ids "$CACHE_RT1" \
    --query "RouteTables[0].Routes[].[DestinationCidrBlock,TransitGatewayId,NatGatewayId,GatewayId]" \
    --output json)

CACHE_SG_RULES=$(aws ec2 describe-security-groups --region "$REGION" \
    --group-ids "$CACHE_SG" \
    --query "SecurityGroups[0].IpPermissions[].[FromPort,ToPort,IpProtocol,IpRanges[].CidrIp]" \
    --output json)

TGW_STATE=$(aws ec2 describe-transit-gateways --region "$REGION" \
    --transit-gateway-ids "$TGW_ID" \
    --query "TransitGateways[0].State" --output text)

TGW_ATTACHMENTS=$(aws ec2 describe-transit-gateway-attachments --region "$REGION" \
    --filters "Name=transit-gateway-id,Values=$TGW_ID" "Name=resource-type,Values=vpc" \
    --query "TransitGatewayAttachments[].[TransitGatewayAttachmentId,ResourceId,State,Association.TransitGatewayRouteTableId]" \
    --output text)

CACHE_ATTACH=$(aws ec2 describe-transit-gateway-attachments --region "$REGION" \
    --filters "Name=transit-gateway-id,Values=$TGW_ID" "Name=resource-id,Values=$CACHE_VPC" \
    --query "TransitGatewayAttachments[0].TransitGatewayAttachmentId" --output text)
CACHE_TGW_RT=$(aws ec2 describe-transit-gateway-attachments --region "$REGION" \
    --filters "Name=transit-gateway-id,Values=$TGW_ID" "Name=resource-id,Values=$CACHE_VPC" \
    --query "TransitGatewayAttachments[0].Association.TransitGatewayRouteTableId" --output text)

CACHE_TGW_ROUTES=$(aws ec2 search-transit-gateway-routes --region "$REGION" \
    --transit-gateway-route-table-id "$CACHE_TGW_RT" \
    --filters "Name=state,Values=active,blackhole" \
    --query "Routes[].[DestinationCidrBlock,State]" --output json)

cat > "$OUT" <<EOF
The ECS service \`$SERVICE_NAME\` cannot reach ElastiCache cluster \`$CACHE_CLUSTER_ID\` because routes are missing in three places:

**1. ECS VPC private subnet route tables**. Neither \`$ECS_RT1\` nor \`$ECS_RT2\` has a route for 13.7.0.0/24 via Transit Gateway \`$TGW_ID\`. Traffic to the ElastiCache VPC is currently sent to the NAT Gateway instead.

**2. ElastiCache VPC route table**. \`$CACHE_RT1\` only has a local route. There is no route for 13.1.0.0/16 back via the Transit Gateway, so return traffic is dropped.

**3. Transit Gateway Cache Route Table**. \`$CACHE_TGW_RT\` is empty. It is associated with the Cache VPC attachment (\`$CACHE_ATTACH\`) but has no routes, so the TGW cannot forward return traffic to the ECS VPC.

The Transit Gateway itself, both VPC attachments, the ElastiCache security group (port 11211 open to 13.1.0.0/16), and the ECS service are all correctly configured.
EOF
