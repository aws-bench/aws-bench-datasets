I'm investigating a Bedrock AgentCore runtime called basalt_agent_mcp in us-west-2. The runtime log group {{api-and-observability-logs-6b635d316-us-west-2-BasaltMcpLogGroupName}} has invocation entries, but our vended logs groups ({{api-and-observability-logs-6b635d316-us-west-2-BasaltMcpApplicationLogsGroupName}}) are empty. My team uses the quartz-team-role to access these logs. Is our IAM policy blocking delivery to the vended logs groups? Or why are they empty?

IMPORTANT: Write your final answer to `/logs/agent/agent-output.txt`.
