#!/bin/bash
set -euo pipefail

REGION="us-east-1"
WS_ENDPOINT="${WS_ENDPOINT:?}"
BUCKET="${AGENT_SCRIPTS_BUCKET:?}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

WORK="$(mktemp -d)"

API_ID="$(printf '%s\n' "$WS_ENDPOINT" | sed -E 's#^wss://([^.]+)\..*#\1#')"

INTEGRATION_URI="$(aws apigatewayv2 get-integrations --region "$REGION" --api-id "$API_ID" \
    --query "Items[0].IntegrationUri" --output text)"
FUNCTION_ARN="$(printf '%s\n' "$INTEGRATION_URI" | sed -E 's#.*functions/(arn:aws:lambda:[^/]+)/invocations#\1#')"
FUNCTION_NAME="${FUNCTION_ARN##*:function:}"

ENV_JSON="$(aws lambda get-function-configuration --region "$REGION" --function-name "$FUNCTION_NAME" \
    --query "Environment.Variables" --output json)"

CODE_URL="$(aws lambda get-function --region "$REGION" --function-name "$FUNCTION_NAME" \
    --query "Code.Location" --output text)"
curl -sL "$CODE_URL" -o "$WORK/code.zip"
unzip -o -q "$WORK/code.zip" -d "$WORK/code"

HANDLER_SRC="$(cat "$WORK/code"/*.js)"
ENDPOINT_REPLACE="$(printf '%s\n' "$HANDLER_SRC" | grep -n "WEBSOCKET_ENDPOINT" | head -1)"
ROUTED_ACTIONS="$(printf '%s\n' "$HANDLER_SRC" | grep -oE "case '[^']+'" | sed -E "s/case '([^']+)'/\1/" | paste -sd ', ' -)"
PING_ROUTED="$(printf '%s\n' "$HANDLER_SRC" | grep -c "case 'ping'" || true)"

for KEY in flint-agent.sh flint-agent-persistent.sh flint-agent-professional.sh; do
    aws s3 cp "s3://$BUCKET/$KEY" "$WORK/$KEY" --region "$REGION"
done

SIMPLE_ACTIONS="$(grep -oE '"action":"[^"]+"' "$WORK/flint-agent.sh" | sort -u | paste -sd ', ' -)"
SIMPLE_RECONNECT="$(grep -nE 'sleep 1|sleep 5|websocat' "$WORK/flint-agent.sh")"
PERSISTENT_ACTIONS="$(grep -oE '"action":"[^"]+"' "$WORK/flint-agent-persistent.sh" | sort -u | paste -sd ', ' -)"
PROFESSIONAL_ACTIONS="$(grep -oE '"action":"[^"]+"' "$WORK/flint-agent-professional.sh" | sort -u | paste -sd ', ' -)"

cat > "$OUT" <<EOF
There are two independent bugs, one in the backend Lambda and one in the agent
script, plus a client-side connection-lifecycle problem. All must be understood
together.

1. Missing WEBSOCKET_ENDPOINT on the Lambda (backend, primary root cause).
The message-handler Lambda ${FUNCTION_NAME} (the AWS_PROXY integration target of
WebSocket API ${API_ID}) has NO WEBSOCKET_ENDPOINT environment variable set. Its
environment only contains: ${ENV_JSON}. The handler's sendToConnection helper
does process.env.WEBSOCKET_ENDPOINT.replace('wss://', 'https://') to build the
API Gateway Management API endpoint (source: ${ENDPOINT_REPLACE}). Because
WEBSOCKET_ENDPOINT is undefined, that line throws
"TypeError: Cannot read properties of undefined (reading 'replace')" the instant
the handler tries to push any reply back to the client. That is why agents
connect and register but never receive a response from the backend: the handler
blows up before it can post the message back over the socket.
Fix: set WEBSOCKET_ENDPOINT on ${FUNCTION_NAME} to the API's callback URL, e.g.
aws lambda update-function-configuration --region ${REGION} --function-name ${FUNCTION_NAME} --environment "Variables={WEBSOCKET_ENDPOINT=${WS_ENDPOINT}}"
(the value may be the wss:// endpoint or the equivalent execute-api https URL for
the prod stage; the helper strips wss:// itself). This fix is required in every
case for the backend to be able to respond at all.

2. Unrouted 'ping' action (backend, second cause).
The handler's switch only routes these actions: ${ROUTED_ACTIONS}. It has no case
for 'ping' (ping case count in handler = ${PING_ROUTED}), so any ping message
falls through to the default branch and returns HTTP 400 ("Unknown action").
flint-agent.sh sends actions: ${SIMPLE_ACTIONS}, which include the unrouted
'ping'. Fix: either add a 'ping' case to the Lambda, or have the agent send an
action the handler recognises (heartbeat).

3. Short-lived socket in flint-agent.sh (client, explains "keep disconnecting").
flint-agent.sh keeps each socket open only ~2 seconds: it pipes a registration
message + sleep 1 + a ping + sleep 1 into websocat, and once that block ends the
pipe closes stdin so websocat tears the connection down (structure:
${SIMPLE_RECONNECT}). The script then sleeps 5s and reconnects in an infinite
loop; that connect/drop/reconnect churn is the "agents keep disconnecting"
symptom. Even with the backend fixed, this script would still cycle the socket
every few seconds.

The same bucket holds two other agent scripts. flint-agent-persistent.sh keeps
the socket open with a periodic loop but still sends actions ${PERSISTENT_ACTIONS}
(the unrouted 'ping'), so its pings would still 400. flint-agent-professional.sh
keeps the socket open and uses actions ${PROFESSIONAL_ACTIONS} (the routed
'heartbeat'), so it behaves correctly on the client side. Either way the backend
stays broken until WEBSOCKET_ENDPOINT is set on ${FUNCTION_NAME}.
EOF
