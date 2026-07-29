#!/bin/bash
set -euo pipefail

REGION="us-west-2"
FUNCTION_NAME="${LAMBDA_FUNCTION_NAME}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

CONFIG=$(aws lambda get-function-configuration --region "$REGION" --function-name "$FUNCTION_NAME")
ANALYTICS_BUCKET=$(echo "$CONFIG" | jq -r '.Environment.Variables.ANALYTICS_S3_BUCKET')
ANALYTICS_REGION=$(echo "$CONFIG" | jq -r '.Environment.Variables.ANALYTICS_S3_REGION')
VPC_ID=$(echo "$CONFIG" | jq -r '.VpcConfig.VpcId')
SUBNET_IDS=$(echo "$CONFIG" | jq -r '.VpcConfig.SubnetIds | join(",")')

ENDPOINTS=$(aws ec2 describe-vpc-endpoints --region "$REGION" \
    --filters "Name=vpc-id,Values=$VPC_ID" \
    --query "VpcEndpoints[].{Type:VpcEndpointType,Service:ServiceName}" --output text)

ROUTES=$(aws ec2 describe-route-tables --region "$REGION" \
    --filters "Name=association.subnet-id,Values=$SUBNET_IDS" \
    --query "RouteTables[].Routes[].{Dest:DestinationCidrBlock,GW:GatewayId,NAT:NatGatewayId,PL:DestinationPrefixListId}" \
    --output text)
EGRESS_ROUTES=$(printf '%s\n' "$ROUTES" | grep -E 'nat-|igw-' | grep -c . || true)

BUCKET_LOC=$(aws s3api get-bucket-location --bucket "$ANALYTICS_BUCKET" \
    --query "LocationConstraint" --output text)
BUCKET_REGION=$(printf '%s' "$BUCKET_LOC" | sed -e 's/^None$/us-east-1/' -e 's/^null$/us-east-1/')

cat > "$OUT" <<EOF
The reconciliation Lambda ${FUNCTION_NAME} is invoking and consuming SQS messages normally (which is why it shows up healthy in CloudWatch metrics), but it never succeeds in writing the analytics objects to S3, so the analytics pipeline sees no new data.

Root cause: a cross-region S3 write that has no network path out of the Lambda's VPC.

- The Lambda runs inside VPC ${VPC_ID} in isolated subnets (${SUBNET_IDS}) in ${REGION}. Their route tables have no route to a NAT gateway or internet gateway (${EGRESS_ROUTES} egress routes found), so the only AWS connectivity is through the VPC endpoints attached to the VPC.
- Those endpoints are, in ${REGION}:
${ENDPOINTS}
  These include an S3 gateway endpoint and an SQS interface endpoint. A gateway endpoint only routes to the AWS service in the SAME region as the VPC (${REGION}); it cannot reach S3 in any other region.
- The Lambda's environment points its analytics write at a DIFFERENT region: ANALYTICS_S3_BUCKET=${ANALYTICS_BUCKET} with ANALYTICS_S3_REGION=${ANALYTICS_REGION}, and that bucket actually resides in ${BUCKET_REGION}.
- Because the ${REGION} S3 gateway endpoint does not route to ${BUCKET_REGION}, the cross-region PutObject calls have no path and hang until they time out. No objects ever land in the analytics bucket, so the pipeline reports no new data.

By contrast, SQS works fine: the VPC has an SQS interface endpoint (with private DNS), so the Lambda receives and processes reconciliation requests normally — hence the healthy invocation metrics.

Fix: make the analytics write reachable from the isolated subnets. Either point the Lambda at an S3 bucket in ${REGION} (same region as the gateway endpoint), or give the VPC a real network path to ${BUCKET_REGION} S3 — e.g. move the function to private subnets with NAT egress — since a same-region gateway endpoint cannot serve a cross-region bucket.
EOF
