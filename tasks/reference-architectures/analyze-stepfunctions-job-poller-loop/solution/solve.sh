#!/bin/bash
set -euo pipefail

REGION="us-east-1"
STATE_MACHINE_NAME="${STATE_MACHINE_NAME}"
CHECK_STATUS_FUNCTION_NAME="${CHECK_STATUS_FUNCTION_NAME}"
RULE_NAME="${RULE_NAME}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

SM_ARN=$(aws stepfunctions list-state-machines --region "$REGION" \
    --query "stateMachines[?name=='${STATE_MACHINE_NAME}'].stateMachineArn | [0]" --output text)

DEFINITION=$(aws stepfunctions describe-state-machine --region "$REGION" --state-machine-arn "$SM_ARN" \
    --query definition --output text)

TIMEOUT=$(printf '%s' "$DEFINITION" | python3 -c 'import sys,json;print(json.load(sys.stdin)["TimeoutSeconds"])')

CHECK_ARN=$(aws lambda get-function --region "$REGION" --function-name "$CHECK_STATUS_FUNCTION_NAME" \
    --query "Configuration.FunctionArn" --output text)

CHECK_INVOCATIONS=$(printf '%s' "$DEFINITION" | CHECK_ARN="$CHECK_ARN" python3 -c '
import sys,json,os
d=json.load(sys.stdin)
arn=os.environ["CHECK_ARN"]
n=0
for st in d["States"].values():
    if st.get("Type")=="Task":
        fn=st.get("Parameters",{}).get("FunctionName","")
        if fn==arn:
            n+=1
print(n)')

SUBMIT_STATE_ARN=$(printf '%s' "$DEFINITION" | python3 -c '
import sys,json
d=json.load(sys.stdin)
print(d["States"][d["StartAt"]]["Parameters"]["FunctionName"])')
SUBMIT_FUNCTION_NAME=$(printf '%s' "$SUBMIT_STATE_ARN" | awk -F: '{print $NF}')

WORKDIR=$(mktemp -d)
SUBMIT_URL=$(aws lambda get-function --region "$REGION" --function-name "$SUBMIT_FUNCTION_NAME" \
    --query "Code.Location" --output text)
curl -s -o "$WORKDIR/submit.zip" "$SUBMIT_URL"
SUBMIT_CODE=$(cd "$WORKDIR" && unzip -p submit.zip index.py)

CHECK_URL=$(aws lambda get-function --region "$REGION" --function-name "$CHECK_STATUS_FUNCTION_NAME" \
    --query "Code.Location" --output text)
curl -s -o "$WORKDIR/check.zip" "$CHECK_URL"
CHECK_CODE=$(cd "$WORKDIR" && unzip -p check.zip index.py)

EXECS=$(aws stepfunctions list-executions --region "$REGION" --state-machine-arn "$SM_ARN" \
    --max-items 20 --query "executions[?status=='SUCCEEDED'].executionArn" --output text)

DURATIONS=$(for E in $EXECS; do
    aws stepfunctions describe-execution --region "$REGION" --execution-arn "$E" \
        --query "[startDate,stopDate]" --output text
done | python3 -c '
import sys
from datetime import datetime
ds=[]
for line in sys.stdin:
    p=line.split()
    if len(p)!=2: continue
    a=datetime.fromisoformat(p[0]); b=datetime.fromisoformat(p[1])
    ds.append((b-a).total_seconds())
if ds:
    print("%.0f" % (sum(ds)/len(ds)))')

RULE_SCHEDULE=$(aws events describe-rule --region "$REGION" --name "$RULE_NAME" \
    --query "ScheduleExpression" --output text)
RULE_INPUT=$(aws events list-targets-by-rule --region "$REGION" --rule "$RULE_NAME" \
    --query "Targets[0].Input" --output text)

TIMING_SENTENCE="No recent SUCCEEDED executions were available to measure end-to-end duration."
if [ -n "$DURATIONS" ]; then
    TIMING_SENTENCE="Recent SUCCEEDED executions of this state machine average ~${DURATIONS} seconds end-to-end (the 30s Wait plus two ~50ms Lambda calls plus overhead)."
fi

cat > "$OUT" <<EOF
CheckStatus (${CHECK_STATUS_FUNCTION_NAME}) runs exactly TWICE per production execution, and the Wait30Seconds -> CheckStatus loop never iterates, because the handlers in this stack are stubs that hard-code a SUCCEEDED status on the first call.

SubmitJob (${SUBMIT_FUNCTION_NAME}) handler code:

${SUBMIT_CODE}

It ignores its input and always emits status=SUCCEEDED; it does not call AWS Batch, ECS, Glue, or any external system.

CheckStatus (${CHECK_STATUS_FUNCTION_NAME}) handler code:

${CHECK_CODE}

It simply echoes SUCCEEDED, or collapses anything else to FAILED.

ASL flow: StartAt SubmitJob -> Wait30Seconds -> CheckStatus -> JobComplete (a Choice on \$.status). If status == SUCCEEDED it goes to GetFinalJobStatus (which invokes the same CheckStatus Lambda one more time) then ends; if status == FAILED it goes to JobFailed (a terminal Fail state); otherwise (Default) it loops back to Wait30Seconds. The state machine definition shows ${CHECK_INVOCATIONS} states invoke the CheckStatus Lambda ARN (${CHECK_ARN}).

Because SubmitJob sets status=SUCCEEDED immediately, the first CheckStatus invocation observes SUCCEEDED, the Choice takes the SUCCEEDED branch, and the execution transitions to GetFinalJobStatus -- which invokes the same CheckStatus Lambda a second time before ending. That is 2 CheckStatus invocations total. ${TIMING_SENTENCE}

The Wait -> CheckStatus loop can only iterate if CheckStatus returned a value that is neither SUCCEEDED nor FAILED (the Choice's Default branch back to Wait30Seconds). With the current handler code that case is unreachable: CheckStatus only ever returns SUCCEEDED or FAILED. To make the loop iterate more than once you would have to change SubmitJob to return a non-terminal status, change CheckStatus to return something other than SUCCEEDED/FAILED, or manually start an execution with a custom input that CheckStatus would not immediately terminate on -- but even then CheckStatus's else branch returns FAILED, which is terminal.

The EventBridge rule ${RULE_NAME} triggers on a cron schedule (${RULE_SCHEDULE}) with no custom input (target Input = ${RULE_INPUT}), so it delivers the default scheduled-event payload (top-level fields like id, detail-type, source, etc.). SubmitJob's event["id"] therefore resolves to the EventBridge event id rather than any real job id. The ${TIMEOUT}-second state-machine-level TimeoutSeconds is effectively never exercised.
EOF
