import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: bedrock-agent-dwiwbg5rr
 *
 * d708bf7d-96a5-4044-8d96-08d82d5ab29e
 *
 * What the stack does:
 * 1. Creates an IAM role for the Bedrock Agent
 * 2. Creates SSM parameters that reference knowledge bases via cross-stack import
 * 3. Creates an S3 bucket for session artifacts
 */

export interface BedrockAgentStackProps extends cdk.StackProps {
    readonly escalationKbId: string;
    readonly metadataKbId: string;
}

export class BedrockAgent_dwiwbg5rr extends cdk.Stack {
    public readonly agentRoleArn: string;
    public readonly sessionArtifactsBucketName: string;

    constructor(scope: Construct, id: string, props: BedrockAgentStackProps) {
        super(scope, id, props);

        // Create S3 bucket for session artifacts
        const sessionArtifactsBucket = new s3.Bucket(this, 'SessionArtifactsBucket', {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        // Create IAM role for Bedrock Agent
        const agentRole = new iam.Role(this, 'BedrockAgentExecutionRole', {
            roleName: `FlintBedrockAgentExecutionRole-beta-${this.account}`,
            assumedBy: new iam.CompositePrincipal(
                new iam.ServicePrincipal('bedrock.amazonaws.com'),
                new iam.ServicePrincipal('bedrock.amazonaws.com').withConditions({
                    StringEquals: {
                        'aws:SourceAccount': this.account,
                    },
                    ArnLike: {
                        'aws:SourceArn': `arn:aws:bedrock:${this.region}:${this.account}:agent/*`,
                    },
                }),
            ),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonBedrockFullAccess'),
            ],
        });

        agentRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    'lambda:GetFunction',
                    'lambda:GetFunctionConfiguration',
                    'lambda:InvokeFunction',
                ],
                resources: [`arn:aws:lambda:${this.region}:${this.account}:function:*`],
            }),
        );

        agentRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['cloudwatch:PutMetricData'],
                resources: ['*'],
                conditions: {
                    StringEquals: {
                        'cloudwatch:namespace': 'AWS/Bedrock/Agents',
                    },
                },
            }),
        );

        agentRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    's3:GetBucketLocation',
                    's3:GetObject',
                    's3:ListBucket',
                ],
                resources: [
                    sessionArtifactsBucket.bucketArn,
                    `${sessionArtifactsBucket.bucketArn}/*`,
                ],
            }),
        );

        agentRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    'kms:CreateGrant',
                    'kms:Decrypt',
                    'kms:DescribeKey',
                    'kms:Encrypt',
                    'kms:GenerateDataKey',
                    'kms:ListGrants',
                    'kms:ReEncrypt*',
                ],
                resources: [`arn:aws:kms:${this.region}:${this.account}:key/*`],
            }),
        );

        agentRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    'bedrock:Retrieve',
                ],
                resources: [
                    `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*`,
                ],
            }),
        );

        // Create SSM parameter that stores agent configuration with KB references
        // Uses Fn::ImportValue explicitly to create a stable, named cross-stack dependency
        const metadataKbId = cdk.Fn.importValue(`${this.stackName.replace('bedrock-agent', 'bedrock-kb')}-MetadataKBKnowledgeBaseId`);
        const escalationKbId = cdk.Fn.importValue(`${this.stackName.replace('bedrock-agent', 'bedrock-kb')}-EscalationWriteupsKBKnowledgeBaseId`);

        const agentConfigParam = new ssm.StringParameter(this, 'AgentConfigParam', {
            parameterName: `/flint/beta/agent/pr-escalation-config-${this.account}`,
            stringValue: cdk.Fn.join('', [
                `{"agentName":"flint-pr-escalation-agent-beta-${this.account}","description":"flint-pr-escalation-agent-test","foundationModel":"anthropic.claude-3-sonnet-20240229-v1:0","knowledgeBases":[{"knowledgeBaseId":"`,
                metadataKbId,
                '","description":"Comprehensive knowledge base covering business contexts, terminologies, data structures for in-depth metric analysis, order processing & customer journey investigations."},{"knowledgeBaseId":"',
                escalationKbId,
                '","description":"Writeups"}]}',
            ]),
            description: 'Agent configuration with KB references',
        });

        this.agentRoleArn = agentRole.roleArn;
        this.sessionArtifactsBucketName = sessionArtifactsBucket.bucketName;

        StackUtils.exportStack(
            this,
            'AgentRoleArn',
            agentRole.roleArn,
            'The ARN of the Bedrock Agent Execution Role',
        );

        StackUtils.exportStack(
            this,
            'SessionArtifactsBucketName',
            sessionArtifactsBucket.bucketName,
            'The name of the Session Artifacts S3 Bucket',
        );

        StackUtils.exportStack(
            this,
            'AgentConfigParamName',
            agentConfigParam.parameterName,
            'The name of the Agent Config SSM Parameter',
        );
    }
}
