#!/bin/bash
set -euo pipefail

REGION="us-east-1"
STACK="troubleshooting-multiservice-cloudformation-t9dx4pgqw-us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

STATUS=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query 'Stacks[0].StackStatus' --output text)

SES_ARN=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='SimpleEmailServiceLambdaArn'].OutputValue|[0]" --output text)
GDO_ARN=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='GetDetectorOutcomeLambdaArn'].OutputValue|[0]" --output text)
SES_ALIAS_ID=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='SimpleEmailServiceLambdaAliasLogicalId'].OutputValue|[0]" --output text)
GDO_ALIAS_ID=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='GetDetectorOutcomeLambdaAliasLogicalId'].OutputValue|[0]" --output text)

SES_REASON=$(aws cloudformation describe-stack-events --region "$REGION" --stack-name "$STACK" \
    --query "StackEvents[?LogicalResourceId=='$SES_ALIAS_ID' && ResourceStatus=='UPDATE_FAILED']|[0].ResourceStatusReason" --output text)
GDO_REASON=$(aws cloudformation describe-stack-events --region "$REGION" --stack-name "$STACK" \
    --query "StackEvents[?LogicalResourceId=='$GDO_ALIAS_ID' && ResourceStatus=='UPDATE_FAILED']|[0].ResourceStatusReason" --output text)
SES_VER=$(printf '%s' "$SES_REASON" | sed -E 's/.*:([0-9]+) \(Service.*/\1/')
GDO_VER=$(printf '%s' "$GDO_REASON" | sed -E 's/.*:([0-9]+) \(Service.*/\1/')

TEMPLATE=$(aws cloudformation get-template --region "$REGION" --stack-name "$STACK" \
    --template-stage Original --query TemplateBody --output json)
SES_TPL_VER=$(printf '%s' "$TEMPLATE" | python3 -c 'import sys,json
tb=json.load(sys.stdin)
tb=json.loads(tb) if isinstance(tb,str) else tb
print(tb["Resources"][sys.argv[1]]["Properties"]["FunctionVersion"])' "$SES_ALIAS_ID")
GDO_TPL_VER=$(printf '%s' "$TEMPLATE" | python3 -c 'import sys,json
tb=json.load(sys.stdin)
tb=json.loads(tb) if isinstance(tb,str) else tb
print(tb["Resources"][sys.argv[1]]["Properties"]["FunctionVersion"])' "$GDO_ALIAS_ID")

cat > "$OUT" <<EOF
The stack $STACK is in $STATUS. The failing update points its Lambda alias resources at function versions that do not exist:

- Alias $SES_ALIAS_ID (SimpleEmailServiceLambdaAlias) references version $SES_VER of $SES_ARN, and CloudFormation reports: $SES_REASON
- Alias $GDO_ALIAS_ID (GetDetectorOutcomeLambdaAlias) references version $GDO_VER of $GDO_ARN, and CloudFormation reports: $GDO_REASON

Those versions were published into the template as hardcoded literal string values (FunctionVersion "$SES_TPL_VER" and "$GDO_TPL_VER") rather than deriving them from the function with !GetAtt Function.Version, so the versions do not exist and the aliases cannot be created — leaving the stack unable to roll back.

To fix this and continue the deployment, skip the two failing alias resources so the rollback can complete:

aws cloudformation continue-update-rollback --stack-name $STACK --resources-to-skip $SES_ALIAS_ID $GDO_ALIAS_ID --region $REGION

Once the stack returns to UPDATE_ROLLBACK_COMPLETE, correct the template so each alias references a valid version (use !GetAtt Function.Version instead of a hardcoded number) and redeploy.
EOF
