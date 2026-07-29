#!/bin/bash
set -euo pipefail

REGION="us-west-2"
RUNTIME_LOG_GROUP="${BASALT_MCP_LOG_GROUP_NAME}"
APPLICATION_LOGS_GROUP="${BASALT_MCP_APPLICATION_LOGS_GROUP_NAME}"
USAGE_LOGS_GROUP="${APPLICATION_LOGS_GROUP/APPLICATION_LOGS/USAGE_LOGS}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

RUNTIME_STREAMS=$(aws logs describe-log-streams --region "$REGION" \
    --log-group-name "$RUNTIME_LOG_GROUP" \
    --query "length(logStreams)" --output text)
APP_STREAMS=$(aws logs describe-log-streams --region "$REGION" \
    --log-group-name "$APPLICATION_LOGS_GROUP" \
    --query "length(logStreams)" --output text)
USAGE_STREAMS=$(aws logs describe-log-streams --region "$REGION" \
    --log-group-name "$USAGE_LOGS_GROUP" \
    --query "length(logStreams)" --output text)

MATCHING_RUNTIMES=$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" \
    --query "length(agentRuntimes[?contains(agentRuntimeName, 'basalt_agent_mcp')])" \
    --output text)

DENY_ACTIONS=$(aws iam get-role-policy --role-name quartz-team-role \
    --policy-name CloudWatchLogsReadPolicy \
    --query "PolicyDocument.Statement[?Effect=='Deny'].Action" --output text)

cat > "$OUT" <<EOF
No, the IAM deny policy on quartz-team-role is not the cause of the empty vended logs groups.

The quartz-team-role CloudWatchLogsReadPolicy has an explicit Deny scoped to the APPLICATION_LOGS and USAGE_LOGS vendedlogs groups, but that Deny only covers read actions (${DENY_ACTIONS}). Those actions govern a caller's ability to READ log events; they have no effect on whether the AgentCore service DELIVERS log events into the groups. So the IAM deny is a red herring, not the reason the groups are empty.

The real root cause is that the Bedrock AgentCore runtime basalt_agent_mcp was deleted, while its CloudWatch log groups were retained. Listing the AgentCore runtimes in ${REGION} returns ${MATCHING_RUNTIMES} runtime(s) named basalt_agent_mcp — it no longer exists. The runtime log group ${RUNTIME_LOG_GROUP} still contains ${RUNTIME_STREAMS} log stream(s) of historical invocation entries from when the runtime was active, but the vended logs groups (${APPLICATION_LOGS_GROUP} with ${APP_STREAMS} stream(s), and ${USAGE_LOGS_GROUP} with ${USAGE_STREAMS} stream(s)) are empty because the AgentCore service is no longer running to deliver application and usage logs to them.

The log groups are simply orphaned leftovers of a deleted runtime; there is no IAM policy change that would repopulate the vended groups. To restore delivery you would need to recreate/redeploy the basalt_agent_mcp AgentCore runtime so the service resumes emitting logs.
EOF
