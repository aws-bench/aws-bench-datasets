#!/bin/bash
set -euo pipefail

REGION="ap-northeast-2"
INSTANCE_ID="${WORKLOAD_INSTANCE_ID}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

read -r SUBNET_ID WORKLOAD_VPC_ID < <(aws ec2 describe-instances --region "$REGION" \
    --instance-ids "$INSTANCE_ID" \
    --query "Reservations[].Instances[].[SubnetId,VpcId]" --output text)

WORKLOAD_RT_ID=$(aws ec2 describe-route-tables --region "$REGION" \
    --filters "Name=association.subnet-id,Values=$SUBNET_ID" \
    --query "RouteTables[].RouteTableId" --output text)

TGW_ID=$(aws ec2 describe-route-tables --region "$REGION" \
    --route-table-ids "$WORKLOAD_RT_ID" \
    --query "RouteTables[].Routes[?DestinationCidrBlock=='0.0.0.0/0'].TransitGatewayId | [0]" --output text)

WORKLOAD_ATTACHMENT_ID=$(aws ec2 describe-transit-gateway-attachments --region "$REGION" \
    --filters "Name=transit-gateway-id,Values=$TGW_ID" "Name=resource-id,Values=$WORKLOAD_VPC_ID" \
    --query "TransitGatewayAttachments[].TransitGatewayAttachmentId" --output text)

TGW_RT_ID=$(aws ec2 describe-transit-gateway-attachments --region "$REGION" \
    --transit-gateway-attachment-ids "$WORKLOAD_ATTACHMENT_ID" \
    --query "TransitGatewayAttachments[].Association.TransitGatewayRouteTableId" --output text)

DMZ_ATTACHMENT_ID=$(aws ec2 search-transit-gateway-routes --region "$REGION" \
    --transit-gateway-route-table-id "$TGW_RT_ID" \
    --filters "Name=route-search.exact-match,Values=0.0.0.0/0" \
    --query "Routes[].TransitGatewayAttachments[].TransitGatewayAttachmentId" --output text)

DMZ_VPC_ID=$(aws ec2 describe-transit-gateway-attachments --region "$REGION" \
    --transit-gateway-attachment-ids "$DMZ_ATTACHMENT_ID" \
    --query "TransitGatewayAttachments[].ResourceId" --output text)

DMZ_VPC_CIDR=$(aws ec2 describe-vpcs --region "$REGION" \
    --vpc-ids "$DMZ_VPC_ID" \
    --query "Vpcs[].CidrBlock | [0]" --output text)

DMZ_IGW=$(aws ec2 describe-internet-gateways --region "$REGION" \
    --filters "Name=attachment.vpc-id,Values=$DMZ_VPC_ID" \
    --query "InternetGateways[].InternetGatewayId" --output text)

DMZ_ROUTE_DESTS=$(aws ec2 describe-route-tables --region "$REGION" \
    --filters "Name=vpc-id,Values=$DMZ_VPC_ID" \
    --query "RouteTables[].Routes[].DestinationCidrBlock" --output text)

cat > "$OUT" <<EOF
No. Outbound internet traffic from instance $INSTANCE_ID does not pass through AWS Network Firewall.

The DMZ VPC ($DMZ_VPC_ID) has no Internet Gateway and its route tables only contain the local $DMZ_VPC_CIDR route (destinations found: $DMZ_ROUTE_DESTS), so traffic never reaches the firewall endpoints. The workload subnet route table ($WORKLOAD_RT_ID) sends 0.0.0.0/0 to Transit Gateway $TGW_ID, and the Transit Gateway route table ($TGW_RT_ID) forwards 0.0.0.0/0 to the DMZ VPC attachment ($DMZ_ATTACHMENT_ID). However, the DMZ VPC has no path out, so traffic never leaves to the internet and never traverses the Network Firewall.
EOF
