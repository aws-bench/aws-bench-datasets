#!/bin/bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
DOMAIN="${AD_DOMAIN:-corp.example.com}"
SHORT="${AD_SHORT_NAME:-CORP}"
PASSWORD="${AD_PASSWORD:-C0rpSecret#2024x}"
OUT=/logs/agent/agent-output.txt
OUT_JSON=/logs/agent/agent-output.json
mkdir -p "$(dirname "$OUT")"

VPC_ID="$(aws ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)"
read -r AZ1 SUB1 < <(aws ec2 describe-subnets --region "$REGION" \
  --filters "Name=vpc-id,Values=${VPC_ID}" \
  --query 'Subnets[0].[AvailabilityZone,SubnetId]' --output text)
SUB2="$(aws ec2 describe-subnets --region "$REGION" \
  --filters "Name=vpc-id,Values=${VPC_ID}" \
  --query "Subnets[?AvailabilityZone!='${AZ1}'] | [0].SubnetId" --output text)"
DIRECTORY_ID="$(aws ds create-microsoft-ad --region "$REGION" \
  --name "$DOMAIN" --short-name "$SHORT" --password "$PASSWORD" \
  --description "Managed Microsoft AD with LDAPS" --edition Standard \
  --vpc-settings "VpcId=${VPC_ID},SubnetIds=${SUB1},${SUB2}" \
  --query DirectoryId --output text)"

printf '{\n  "directory_id": "%s"\n}\n' "$DIRECTORY_ID" > "$OUT_JSON"

until [ "$(aws ds describe-directories --region "$REGION" --directory-ids "$DIRECTORY_ID" \
  --query 'DirectoryDescriptions[0].Stage' --output text)" = "Active" ]; do sleep 30; done

openssl genrsa -out /tmp/ca-key.pem 2048
openssl req -new -x509 -days 3650 -key /tmp/ca-key.pem -out /tmp/ca-cert.pem \
  -subj "/C=US/ST=WA/L=Seattle/O=Corp/CN=${DOMAIN} CA"

aws ds register-certificate --region "$REGION" --directory-id "$DIRECTORY_ID" \
  --certificate-data file:///tmp/ca-cert.pem --type ClientLDAPS

until [ "$(aws ds list-certificates --region "$REGION" --directory-id "$DIRECTORY_ID" \
  --query "CertificatesInfo[?Type=='ClientLDAPS'] | [0].State" --output text)" = "Registered" ]; do sleep 30; done

aws ds enable-ldaps --region "$REGION" --directory-id "$DIRECTORY_ID" --type Client

echo "Done." > "$OUT"
