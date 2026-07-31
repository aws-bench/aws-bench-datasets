#!/bin/bash
set -euo pipefail

REGION="us-east-1"
ONYX_FUNCTION_NAME="${ONYX_FUNCTION_NAME:?}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

WORKDIR="$(mktemp -d)"
CODE_URL="$(aws lambda get-function --function-name "$ONYX_FUNCTION_NAME" --region "$REGION" --query 'Code.Location' --output text)"
curl -s "$CODE_URL" -o "$WORKDIR/code.zip"
unzip -o -q "$WORKDIR/code.zip" -d "$WORKDIR/code"
HANDLER_SRC="$(cat "$WORKDIR/code"/index.py)"
OLDIMAGE_CHECK="$(printf '%s\n' "$HANDLER_SRC" | grep -n 'OldImage' | head -1)"
STATE_CHECK="$(printf '%s\n' "$HANDLER_SRC" | grep -n 'IN_PROGRESS' | grep -i 'old_state\|new_state' | head -1)"

BASALT_TABLE="$(aws lambda get-function-configuration --function-name "$ONYX_FUNCTION_NAME" --region "$REGION" \
    --query 'Environment.Variables.BASALT_REQUESTS_TABLE' --output text)"

SOURCE_ARNS="$(aws lambda list-event-source-mappings --function-name "$ONYX_FUNCTION_NAME" --region "$REGION" \
    --query 'EventSourceMappings[].EventSourceArn' --output text)"
REGRESSION_TABLE="$(printf '%s\n' $SOURCE_ARNS | awk -F/ '{print $2}' | grep 'RegressionRequests' | grep -- '-alpha$' | grep -v '^Bulk' | head -1)"

REGRESSION_STREAM_VIEW="$(aws dynamodb describe-table --table-name "$REGRESSION_TABLE" --region "$REGION" \
    --query 'Table.StreamSpecification.StreamViewType' --output text)"
BASALT_STREAM_VIEW="$(aws dynamodb describe-table --table-name "$BASALT_TABLE" --region "$REGION" \
    --query 'Table.StreamSpecification.StreamViewType' --output text)"

cat > "$OUT" <<EOF
Root cause: the Onyx Lambda ($ONYX_FUNCTION_NAME) silently drops bulk regression requests because of its DynamoDB stream filter logic, not because of any misconfigured trigger, stream, or permission.

Its event source mappings and streams are healthy: the function is wired to the $REGRESSION_TABLE table (stream view $REGRESSION_STREAM_VIEW) and to the $BASALT_TABLE table (stream view $BASALT_STREAM_VIEW), both of which include old images.

The handler source (index.py fetched from the deployed function) first checks whether each stream record contains an OldImage and skips any record that does not:

    $OLDIMAGE_CHECK

Only records that DO carry an OldImage proceed, and even then it processes only a transition into IN_PROGRESS:

    $STATE_CHECK

Why bulk regression requests fail:
Bulk regression requests are written directly into the $REGRESSION_TABLE table already in state IN_PROGRESS. A direct write produces an INSERT DynamoDB stream event, and INSERT events carry only a NewImage with no OldImage. Because the handler skips every record without an OldImage, each bulk regression INSERT is skipped and never triggers a Quartz test (incrementing the Basalt/Onyx SkippedRecords metric).

Why individual BAT requests work:
BAT requests are first created in the $BASALT_TABLE table in state BUFFER, then later updated to IN_PROGRESS. The update produces a MODIFY stream event that includes both an OldImage (state=BUFFER) and a NewImage (state=IN_PROGRESS). Because the record has an OldImage and represents a transition into IN_PROGRESS, the handler processes it.

Fix: change the handler so it does not require an OldImage. Treat INSERT events whose NewImage state is IN_PROGRESS the same as MODIFY transitions into IN_PROGRESS (i.e. process a record when new_state == "IN_PROGRESS" and old_state != "IN_PROGRESS", where a missing OldImage means old_state is empty), so directly-inserted IN_PROGRESS bulk regression requests are no longer skipped.
EOF
