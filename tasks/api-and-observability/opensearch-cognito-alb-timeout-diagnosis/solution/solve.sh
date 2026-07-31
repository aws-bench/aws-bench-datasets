#!/bin/bash
set -euo pipefail

REGION="us-east-1"
DOMAIN="${OPENSEARCH_DOMAIN_NAME:?}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

CUSTOM_ENDPOINT_ENABLED=$(aws opensearch describe-domain --domain-name "$DOMAIN" --region "$REGION" \
    --query "DomainStatus.DomainEndpointOptions.CustomEndpointEnabled" --output text)
COGNITO_ENABLED=$(aws opensearch describe-domain --domain-name "$DOMAIN" --region "$REGION" \
    --query "DomainStatus.CognitoOptions.Enabled" --output text)
VPC_ENDPOINT=$(aws opensearch describe-domain --domain-name "$DOMAIN" --region "$REGION" \
    --query "DomainStatus.Endpoints.vpc" --output text)
VPC_ID=$(aws opensearch describe-domain --domain-name "$DOMAIN" --region "$REGION" \
    --query "DomainStatus.VPCOptions.VPCId" --output text)

ALB_DNS=$(aws elbv2 describe-load-balancers --region "$REGION" \
    --query "LoadBalancers[?VpcId=='${VPC_ID}' && Scheme=='internal'].DNSName | [0]" --output text)

cat > "$OUT" <<EOF
Root cause: the OpenSearch domain "$DOMAIN" (Cognito dashboard auth enabled = ${COGNITO_ENABLED})
has no custom endpoint configured (DomainEndpointOptions.CustomEndpointEnabled = ${CUSTOM_ENDPOINT_ENABLED}).

Because no custom endpoint is set, OpenSearch/Cognito uses the domain's raw VPC endpoint hostname
(${VPC_ENDPOINT}) as the redirect target. After a user authenticates on the Cognito hosted login
page, Cognito redirects the browser to that private VPC endpoint hostname instead of the internal
ALB. That hostname only resolves and is only reachable from inside the VPC, so from the user's
browser over VPN — which reaches the dashboards through the ALB — the redirect target is
unreachable and the page hangs / times out. The login page itself loads fine because it is served
by Cognito's hosted UI; only the post-authentication redirect points at the wrong (private) host.

Fix: configure a custom endpoint on the OpenSearch domain that points to the internal ALB's DNS
name (${ALB_DNS}), backed by an ACM certificate whose subject/SAN matches that name. This makes the
Cognito post-authentication redirect resolve to the ALB rather than the raw VPC endpoint, so the
dashboards load. For example:

  aws opensearch update-domain-config --domain-name "$DOMAIN" --region "$REGION" \\
    --domain-endpoint-options \\
    CustomEndpointEnabled=true,CustomEndpoint=${ALB_DNS},CustomEndpointCertificateArn=<acm-cert-arn>

Once the custom endpoint (matching the ALB) is set, the redirect after login resolves to the ALB
and the dashboards load correctly.
EOF
