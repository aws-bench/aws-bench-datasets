import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

// Log group names for basalt_agent_mcp — created by the pre-invoke script
// (not by this stack) so they appear as orphaned service-created log groups
// with no CloudFormation association.
const BASALT_MCP_RUNTIME_LOG_GROUP = '/aws/bedrock-agentcore/runtimes/basalt_agent_mcp-kR7vPq2wXn-DEFAULT';
const BASALT_MCP_APPLICATION_LOGS_GROUP = '/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/basalt_agent_mcp-kR7vPq2wXn';
const BASALT_MCP_USAGE_LOGS_GROUP = '/aws/vendedlogs/bedrock-agentcore/runtime/USAGE_LOGS/basalt_agent_mcp-kR7vPq2wXn';

export class logs_6b635d316 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // Unrelated AgentCore runtime log group (noise)
        new logs.LogGroup(this, 'OnyxAgentRuntimeLogGroup', {
            logGroupName: '/aws/bedrock-agentcore/runtimes/onyx_agent_basalt-mT4jLs9dYp-DEFAULT',
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // IAM role with deny on vendedlogs (red herring)
        const role = new iam.Role(this, 'QuartzTeamRole', {
            roleName: 'quartz-team-role',
            assumedBy: new iam.ServicePrincipal('sts.amazonaws.com'),
            description: 'Role for accessing Bedrock AgentCore logs and agent metadata',
        });

        role.attachInlinePolicy(new iam.Policy(this, 'CloudWatchLogsReadPolicy', {
            policyName: 'CloudWatchLogsReadPolicy',
            statements: [
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'logs:DescribeLogGroups',
                        'logs:FilterLogEvents',
                        'logs:GetLogEvents',
                    ],
                    resources: [
                        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/*`,
                        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/*`,
                        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/batch/*`,
                    ],
                }),
                new iam.PolicyStatement({
                    effect: iam.Effect.DENY,
                    actions: [
                        'logs:FilterLogEvents',
                        'logs:GetLogEvents',
                    ],
                    resources: [
                        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/*`,
                        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/vendedlogs/bedrock-agentcore/runtime/USAGE_LOGS/*`,
                    ],
                }),
            ],
        }));

        role.attachInlinePolicy(new iam.Policy(this, 'BedrockAgentReadPolicy', {
            policyName: 'BedrockAgentReadPolicy',
            statements: [
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'bedrock-agent:ListAgents',
                        'bedrock-agent:GetAgent',
                    ],
                    resources: ['*'],
                }),
            ],
        }));

        StackUtils.exportStack(this, 'BasaltMcpLogGroupName', BASALT_MCP_RUNTIME_LOG_GROUP, 'Basalt MCP AgentCore runtime log group');
        StackUtils.exportStack(this, 'BasaltMcpApplicationLogsGroupName', BASALT_MCP_APPLICATION_LOGS_GROUP, 'Basalt MCP APPLICATION_LOGS vendedlogs group');
        StackUtils.exportStack(this, 'BasaltMcpUsageLogsGroupName', BASALT_MCP_USAGE_LOGS_GROUP, 'Basalt MCP USAGE_LOGS vendedlogs group');
    }
}
