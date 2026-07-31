#!/bin/bash
set -euo pipefail

REGION="us-east-1"
CLUSTER_ID="${CLUSTER_IDENTIFIER}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

CLUSTER=$(aws rds describe-db-clusters --db-cluster-identifier "$CLUSTER_ID" --region "$REGION" --query 'DBClusters[0]' --output json)
DELETION_PROTECTION=$(printf '%s' "$CLUSTER" | python3 -c 'import sys,json;print(json.load(sys.stdin)["DeletionProtection"])')
MIN_CAP=$(printf '%s' "$CLUSTER" | python3 -c 'import sys,json;print(json.load(sys.stdin)["ServerlessV2ScalingConfiguration"]["MinCapacity"])')
MAX_CAP=$(printf '%s' "$CLUSTER" | python3 -c 'import sys,json;print(json.load(sys.stdin)["ServerlessV2ScalingConfiguration"]["MaxCapacity"])')
MASTER_USER=$(printf '%s' "$CLUSTER" | python3 -c 'import sys,json;print(json.load(sys.stdin)["MasterUsername"])')
INSTANCE_COUNT=$(printf '%s' "$CLUSTER" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["DBClusterMembers"]))')
WRITER_COUNT=$(printf '%s' "$CLUSTER" | python3 -c 'import sys,json;print(sum(1 for m in json.load(sys.stdin)["DBClusterMembers"] if m["IsClusterWriter"]))')
READER_COUNT=$((INSTANCE_COUNT - WRITER_COUNT))
WRITER_ID=$(printf '%s' "$CLUSTER" | python3 -c 'import sys,json;m=[x for x in json.load(sys.stdin)["DBClusterMembers"] if x["IsClusterWriter"]][0];print(m["DBInstanceIdentifier"])')
WRITER_TIER=$(printf '%s' "$CLUSTER" | python3 -c 'import sys,json;m=[x for x in json.load(sys.stdin)["DBClusterMembers"] if x["IsClusterWriter"]][0];print(m["PromotionTier"])')
STACK_NAME=$(printf '%s' "$CLUSTER" | python3 -c 'import sys,json;print([t["Value"] for t in json.load(sys.stdin)["TagList"] if t["Key"]=="aws:cloudformation:stack-name"][0])')
CLUSTER_LOGICAL_ID=$(printf '%s' "$CLUSTER" | python3 -c 'import sys,json;print([t["Value"] for t in json.load(sys.stdin)["TagList"] if t["Key"]=="aws:cloudformation:logical-id"][0])')

WRITER_CLASS=$(aws rds describe-db-instances --db-instance-identifier "$WRITER_ID" --region "$REGION" --query 'DBInstances[0].DBInstanceClass' --output text)

RESOURCES=$(aws cloudformation list-stack-resources --stack-name "$STACK_NAME" --region "$REGION" --query 'StackResourceSummaries[].[ResourceType,LogicalResourceId,PhysicalResourceId]' --output json)
SECRET_ARN=$(printf '%s' "$RESOURCES" | python3 -c 'import sys,json;print([r[2] for r in json.load(sys.stdin) if r[0]=="AWS::SecretsManager::Secret"][0])')
SECRET_LOGICAL_ID=$(printf '%s' "$RESOURCES" | python3 -c 'import sys,json;print([r[1] for r in json.load(sys.stdin) if r[0]=="AWS::SecretsManager::Secret"][0])')

TEMPLATE=$(aws cloudformation get-template --stack-name "$STACK_NAME" --region "$REGION" --query TemplateBody --output json)
CLUSTER_DELPOL=$(printf '%s' "$TEMPLATE" | CLID="$CLUSTER_LOGICAL_ID" python3 -c 'import sys,json,os;r=json.load(sys.stdin)["Resources"][os.environ["CLID"]];print(r.get("DeletionPolicy"))')
CLUSTER_URPOL=$(printf '%s' "$TEMPLATE" | CLID="$CLUSTER_LOGICAL_ID" python3 -c 'import sys,json,os;r=json.load(sys.stdin)["Resources"][os.environ["CLID"]];print(r.get("UpdateReplacePolicy"))')
SECRET_DELPOL=$(printf '%s' "$TEMPLATE" | SLID="$SECRET_LOGICAL_ID" python3 -c 'import sys,json,os;r=json.load(sys.stdin)["Resources"][os.environ["SLID"]];print(r.get("DeletionPolicy"))')
SECRET_URPOL=$(printf '%s' "$TEMPLATE" | SLID="$SECRET_LOGICAL_ID" python3 -c 'import sys,json,os;r=json.load(sys.stdin)["Resources"][os.environ["SLID"]];print(r.get("UpdateReplacePolicy"))')

SECRET=$(aws secretsmanager describe-secret --secret-id "$SECRET_ARN" --region "$REGION" --output json)
ROTATION_ENABLED=$(printf '%s' "$SECRET" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("RotationEnabled"))')
ROTATION_LAMBDA=$(printf '%s' "$SECRET" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("RotationLambdaARN"))')

cat > "$OUT" <<EOF
There are four production-readiness concerns worth flagging before you cut over, each visible in the current deployed state of ${CLUSTER_ID} and its Secrets Manager secret.

First, the cluster is one accidental keystroke away from silent data loss. The cluster has DeletionProtection=${DELETION_PROTECTION}, and its CloudFormation resource carries DeletionPolicy=${CLUSTER_DELPOL} with UpdateReplacePolicy=${CLUSTER_URPOL}. Identical policies (DeletionPolicy=${SECRET_DELPOL}, UpdateReplacePolicy=${SECRET_URPOL}) are set on the attached master secret ${SECRET_ARN}. A cdk destroy or any property change that triggers a cluster or secret replacement will drop the database and its data with no snapshot and no undo. This is the single highest-impact finding.

Second, credential hygiene. The master secret has RotationEnabled=${ROTATION_ENABLED}. Rotation has never been turned on, and there is no RotationLambdaARN attached (RotationLambdaARN=${ROTATION_LAMBDA}). The ${MASTER_USER} password generated at stack deploy is static for the life of the stack and is the same credential the Data API hands to every rds-data:ExecuteStatement call. For production, rotate it on a schedule (or move to managed-master-user-password).

Third, the scaling ceiling is effectively a one-node writer cap. ServerlessV2ScalingConfiguration is MinCapacity=${MIN_CAP}, MaxCapacity=${MAX_CAP} ACU, which tops out at roughly 2 GB of buffer pool and a handful of concurrent connections. Under real concurrency the Data API calls will queue, and the Lambda side will show up as elevated latency and 504s long before the cluster itself looks unhealthy.

Fourth, there is no read-path isolation. The cluster has exactly ${INSTANCE_COUNT} instance in it, the writer (${WRITER_ID}) in promotion tier ${WRITER_TIER}, ${WRITER_CLASS}. Aurora auto-exposes a reader endpoint, but with ${READER_COUNT} reader instances behind it, any traffic sent to the reader endpoint is routed to the writer, so reads contend with writes for the same ${MIN_CAP}-${MAX_CAP} ACU. A read-heavy spike competes directly with inserts.

Minimum fixes before cutover: set deletionProtection=true and flip removalPolicy on the cluster and the secret to RETAIN (or SNAPSHOT), enable rotation on the master secret, raise serverlessV2MaxCapacity to something realistic for the expected concurrency (8-16 ACU is a more typical prod floor), and add at least one reader instance so the reader endpoint is usable.
EOF
