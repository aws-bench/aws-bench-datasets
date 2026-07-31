#!/bin/bash
set -euo pipefail

REGION="${AWS_REGION:-${AWS_REGION:-us-east-1}}"
SUBNET1="${SUBNET_ID_1}"
SUBNET2="${SUBNET_ID_2}"
K8S_VERSION="${K8S_VERSION:-1.33}"
OUT=/logs/agent/agent-output.txt
OUT_JSON=/logs/agent/agent-output.json

ROLE_NAME="${EKS_ROLE_NAME}"
aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/AmazonEKSClusterPolicy
ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)"
sleep 15

CLUSTER_NAME="${CLUSTER_NAME:-eks-cluster-$(date +%Y%m%d-%H%M%S)}"

aws eks create-cluster \
  --name "$CLUSTER_NAME" \
  --kubernetes-version "$K8S_VERSION" \
  --role-arn "$ROLE_ARN" \
  --resources-vpc-config "subnetIds=${SUBNET1},${SUBNET2},endpointPublicAccess=true,endpointPrivateAccess=false" \
  --region "$REGION"

mkdir -p "$(dirname "$OUT")"
printf '{"eks_cluster_name": "%s"}\n' "$CLUSTER_NAME" > "$OUT_JSON"
echo "Done." > "$OUT"
