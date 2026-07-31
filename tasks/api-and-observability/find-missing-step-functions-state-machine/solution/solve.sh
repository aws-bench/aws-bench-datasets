#!/bin/bash
set -euo pipefail

REGION="us-east-1"
SM_NAME="${STATE_MACHINE_NAME}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

STACK_NAME=$(aws cloudformation describe-stacks --region "$REGION" \
    --query "Stacks[?Outputs[?OutputKey=='StateMachineName' && OutputValue=='$SM_NAME']].StackName | [0]" \
    --output text)

STACK_STATUS=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" \
    --query "Stacks[0].StackStatus" --output text)

SM_ARN=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='StateMachineArn'].OutputValue | [0]" --output text)

SM_RESOURCE_STATUS=$(aws cloudformation describe-stack-resources --region "$REGION" --stack-name "$STACK_NAME" \
    --query "StackResources[?ResourceType=='AWS::StepFunctions::StateMachine'].ResourceStatus | [0]" --output text)

SM_LOOKUP=$(aws stepfunctions describe-state-machine --region "$REGION" --state-machine-arn "$SM_ARN" 2>&1 1>/dev/null || true)

CT_EVENTS=$(aws cloudtrail lookup-events --region "$REGION" \
    --lookup-attributes AttributeKey=EventName,AttributeValue=DeleteStateMachine \
    --max-results 50 --query "Events[].CloudTrailEvent" --output text)
DELETE_COUNT=$(printf '%s\n' "$CT_EVENTS" | awk -v a="$SM_ARN" 'index($0,a){n++} END{print n+0}')

cat > "$OUT" <<EOF
The Step Functions state machine $SM_NAME cannot be found because it was manually deleted outside of CloudFormation, leaving the stack in a drifted state.

Evidence:
- CloudFormation stack $STACK_NAME reports status $STACK_STATUS, and it still lists the Step Functions state machine resource as $SM_RESOURCE_STATUS. CloudFormation therefore still believes it manages the state machine.
- Calling describe-state-machine on $SM_ARN fails because the underlying resource no longer exists in the Step Functions service:
  $SM_LOOKUP
- CloudTrail shows $DELETE_COUNT DeleteStateMachine event(s) issued against $SM_ARN after the stack was deployed, confirming the state machine was deleted out-of-band rather than by CloudFormation.

This is configuration drift: the resource still exists in the CloudFormation stack but was deleted directly in the Step Functions service. To restore it, redeploy or update the stack (for example run an aws cloudformation update-stack / cdk deploy on $STACK_NAME) so CloudFormation recreates the state machine.
EOF
