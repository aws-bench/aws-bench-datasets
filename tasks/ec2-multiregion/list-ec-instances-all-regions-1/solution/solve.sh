#!/bin/bash
set -euo pipefail

OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

ALLOWED_REGIONS="$ALLOWED_REGIONS"
REGIONS=$(echo "$ALLOWED_REGIONS" | tr ',' ' ')

REACHABLE=""
for region in $REGIONS; do
    region=$(echo "$region" | tr -d '[:space:]')
    SSH_GROUPS=$(aws ec2 describe-security-groups --region "$region" \
        --filters "Name=ip-permission.from-port,Values=22" "Name=ip-permission.to-port,Values=22" "Name=ip-permission.cidr,Values=0.0.0.0/0" \
        --query "SecurityGroups[].GroupId" --output text)
    for g in $SSH_GROUPS; do
        IDS=$(aws ec2 describe-instances --region "$region" \
            --filters "Name=instance-state-name,Values=running" "Name=instance.group-id,Values=$g" \
            --query "Reservations[].Instances[?PublicIpAddress!=null].InstanceId" --output text)
        for id in $IDS; do
            REACHABLE="$REACHABLE $id"
        done
    done
done

REACHABLE=$(echo "$REACHABLE" | tr ' ' '\n' | grep -v '^$' | sort -u)
COUNT=$(echo "$REACHABLE" | grep -c .)
LIST=$(echo "$REACHABLE" | paste -sd ',' - | sed 's/,/ and /g')

cat > "$OUT" <<EOF
Only $COUNT instances are SSH-reachable from the internet: $LIST.

These are the only EC2 instances (across the account's operating regions: $ALLOWED_REGIONS) that satisfy all of: a running state, a public IPv4 address, and membership in a security group whose inbound rules allow TCP port 22 from 0.0.0.0/0. All other instances in the account either lack a public IP (e.g. private-subnet instances) or use a security group that does not open port 22 to the internet (e.g. default-VPC instances), so they are not SSH-reachable from the internet.
EOF
