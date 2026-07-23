import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';
import { aws_sns_subscriptions, Tags } from 'aws-cdk-lib';
import { StackUtils } from '../lib/shared';

export interface LambdaMiscStackProps extends cdk.StackProps {
    vpc: ec2.IVpc;
}

export class LambdaMiscStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: LambdaMiscStackProps) {
        super(scope, id, props);

        const { vpc } = props;

        // --- Connected Lambda (SNS trigger + SQS dead-letter queue) ---
        const connectedSNSTopic = new sns.Topic(this, 'ConnectedSNSTopic', {
            topicName: 'ConnectedSNSTopic',
        });
        const connectedLambdaLogGroup = new logs.LogGroup(this, 'ConnectedLambdaLogGroup', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const connectedLambda = new lambda.Function(this, 'ConnectedLambda', {
            logGroup: connectedLambdaLogGroup,
            runtime: lambda.Runtime.NODEJS_20_X,
            code: new lambda.InlineCode('exports.handler = async (event) => console.log(event)'),
            handler: 'index.handler',
        });
        const connectedSQS = new sqs.Queue(this, 'ConnectedSQS', { queueName: 'ConnectedSQS' });

        connectedSQS.grantSendMessages(connectedLambda);
        connectedSNSTopic.addSubscription(new aws_sns_subscriptions.LambdaSubscription(connectedLambda));

        // Broken API Gateway — uses an IAM role without lambda:InvokeFunction permission,
        // so the integration cannot actually invoke the function (distractor)
        const brokenApiRole = new iam.Role(this, 'ConnectedApiRole', {
            assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
        });
        const brokenApi = new apigateway.RestApi(this, 'ConnectedApi', {
            restApiName: 'ConnectedLambdaApi',
        });
        brokenApi.root.addResource('process').addMethod('POST', new apigateway.AwsIntegration({
            service: 'lambda',
            path: `2015-03-31/functions/${connectedLambda.functionArn}/invocations`,
            options: { credentialsRole: brokenApiRole },
        }));

        StackUtils.exportStack(this, 'ConnectedSQSURL', connectedSQS.queueUrl);
        StackUtils.exportStack(this, 'ConnectedSNSTopicName', connectedSNSTopic.topicName);
        StackUtils.exportStack(this, 'ConnectedLambdaName', connectedLambda.functionName);
        StackUtils.exportStack(this, 'ConnectedLambdaRuntime', connectedLambda.runtime.toString());
        StackUtils.exportStack(this, 'ConnectedSQSName', connectedSQS.queueName);

        // --- Tagged Lambda ---
        const lambdaWithTagsLogGroup = new logs.LogGroup(this, 'TaggedLambdaLogGroup', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const lambdaWithTags = new lambda.Function(this, 'TaggedLambda', {
            logGroup: lambdaWithTagsLogGroup,
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: new lambda.InlineCode('exports.handler = async (event) => console.log(event)'),
            vpc,
        });
        Tags.of(lambdaWithTags).add('lambda-console:blueprint', 'true');
        StackUtils.exportStack(this, 'TaggedLambdaName', lambdaWithTags.functionName, 'Name of Lambda with tags');

        // --- Concurrent Lambda (version + alias) ---
        const concurrentLambdaLogGroup = new logs.LogGroup(this, 'ConcurrentLambdaLogGroup', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const concurrentLambda = new lambda.Function(this, 'ConcurrentLambda', {
            logGroup: concurrentLambdaLogGroup,
            functionName: 'TriggerWorkflow',
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: new lambda.InlineCode('exports.handler = async (event) => console.log(event)'),
            vpc,
        });

        const version = concurrentLambda.currentVersion;
        version.addAlias('prod');

        StackUtils.exportStack(
            this,
            'ConcurrentLambdaName',
            concurrentLambda.functionName,
            'Name of the Lambda function with provisioned concurrency',
        );

        // --- S3 Lambda Layer ---
        const s3LambdaLayer = new lambda.LayerVersion(this, 'S3Layer', {
            code: lambda.Code.fromAsset('lambda/fetch-instance-ids'),
            compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        StackUtils.exportStack(
            this,
            'S3LayerArnExport',
            s3LambdaLayer.layerVersionArn,
            'ARN of the Lambda layer from s3',
        );

        // --- IAM Roles ---
        const athenaLambdaRole = new iam.Role(this, 'AthenaLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        });

        const docDBLambdaRole = new iam.Role(this, 'DocDBLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        });

        const exporterRole = new iam.Role(this, 'ExporterRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        });

        StackUtils.exportStack(this, 'AthenaLambdaRoleName', athenaLambdaRole.roleName);
        StackUtils.exportStack(this, 'AthenaLambdaRoleArn', athenaLambdaRole.roleArn);
        StackUtils.exportStack(this, 'DocDBLambdaRoleName', docDBLambdaRole.roleName);
        StackUtils.exportStack(this, 'DocDBLambdaRoleArn', docDBLambdaRole.roleArn);
        StackUtils.exportStack(this, 'ExporterRoleName', exporterRole.roleName);
        StackUtils.exportStack(this, 'ExporterRoleArn', exporterRole.roleArn);
    }
}
