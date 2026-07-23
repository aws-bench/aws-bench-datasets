import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: s3_e8i6bw6cu
 *
 * The stack creates the following resources:
 *
 * 1. 2 S3 buckets for training data and outputs
 * 2. Sample JSONL training data deployment
 * 3. 1 IAM role for Bedrock model distillation
 *
 */
export class s3_e8i6bw6cu extends cdk.Stack {
    private readonly accountId: string;

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        this.accountId = this.account;

        // S3 bucket for training data
        const trainingBucket = new s3.Bucket(this, 'TrainingDataBucket', {
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
        });
        trainingBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // S3 bucket for model outputs
        const outputBucket = new s3.Bucket(this, 'ModelOutputBucket', {
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
        });
        outputBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Deploy JSONL training data (Bedrock distillation format:
        // bedrock-conversation-2024, prompt-only — the teacher generates completions).
        new s3deploy.BucketDeployment(this, 'DeployTrainingData', {
            sources: [
                s3deploy.Source.data(
                    'training-data.jsonl',
                    `{"schemaVersion": "bedrock-conversation-2024", "system": [{"text": "You are a helpful assistant."}], "messages": [{"role": "user", "content": [{"text": "What is artificial intelligence?"}]}]}
{"schemaVersion": "bedrock-conversation-2024", "system": [{"text": "You are a helpful assistant."}], "messages": [{"role": "user", "content": [{"text": "Define machine learning."}]}]}`,
                ),
            ],
            destinationBucket: trainingBucket,
        });

        // IAM role for Bedrock distillation
        const bedrockRole = new iam.Role(this, 'BedrockDistillationRole', {
            assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
            inlinePolicies: {
                S3Access: new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
                            resources: [
                                trainingBucket.bucketArn,
                                `${trainingBucket.bucketArn}/*`,
                                outputBucket.bucketArn,
                                `${outputBucket.bucketArn}/*`,
                            ],
                        }),
                    ],
                }),
            },
        });
        bedrockRole.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Export stack information
        StackUtils.exportStack(this, 'TrainingBucketName', trainingBucket.bucketName);
        StackUtils.exportStack(this, 'OutputBucketName', outputBucket.bucketName);
        StackUtils.exportStack(this, 'BedrockRoleName', bedrockRole.roleName);
    }
}
