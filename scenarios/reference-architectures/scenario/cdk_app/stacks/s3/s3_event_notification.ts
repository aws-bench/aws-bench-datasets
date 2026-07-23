import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { StackUtils } from '../../lib/shared';

/*
 * Stack: S3EventNotification
 *
 * Converted from aws-cdk-examples/typescript/lambda-manage-s3-event-notification
 *
 * The original is a multi-stack example (SharedStack, AStack, BStack) that demonstrates
 * cross-stack S3 notification management via a custom Lambda + CustomResource pattern.
 * Here everything is consolidated into a single stack.
 *
 * Creates:
 * 1. S3 bucket (SharedStack)
 * 2. Lambda "notification manager" that uses the S3 SDK to manage bucket notification
 *    configurations (SharedStack)
 * 3. cr.Provider wrapping the manager Lambda
 * 4. SQS queue with S3 send permissions (AStack)
 * 5. CustomResource for SQS notification on CategoryA/ prefix (AStack)
 * 6. SNS topic with S3 publish permissions (BStack)
 * 7. CustomResource for SNS notification on CategoryB/ prefix (BStack)
 */

export class S3EventNotification extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // =====================================================================
        // SharedStack portion: S3 bucket + notification manager Lambda
        // =====================================================================

        const bucket = new s3.Bucket(this, 'EventNotificationBucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
        });

        const notificationManagerFn = new lambda.Function(this, 'NotificationManagerFunction', {
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/s3-notification-manager')),
            timeout: cdk.Duration.seconds(300),
        });

        notificationManagerFn.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['s3:GetBucketNotification', 's3:PutBucketNotification'],
                effect: iam.Effect.ALLOW,
                resources: [bucket.bucketArn],
            })
        );

        // cr.Provider wraps the Lambda and handles CloudFormation response protocol
        const provider = new cr.Provider(this, 'NotificationManagerProvider', {
            onEventHandler: notificationManagerFn,
        });

        // =====================================================================
        // AStack portion: SQS queue + CustomResource for CategoryA/ prefix
        // =====================================================================

        const queue = new sqs.Queue(this, 'S3EventQueue', {
            retentionPeriod: cdk.Duration.days(14),
            enforceSSL: true,
        });
        queue.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Grant S3 permission to send messages to the queue
        queue.grant(new iam.ServicePrincipal('s3.amazonaws.com', {
            conditions: {
                ArnLike: {
                    'aws:SourceArn': bucket.bucketArn,
                },
            },
        }), 'sqs:SendMessage', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl');

        new cdk.CustomResource(this, 'SampleBucketNotificationA', {
            serviceToken: provider.serviceToken,
            properties: {
                BucketName: bucket.bucketName,
                NotificationConfiguration: {
                    QueueConfigurations: [
                        {
                            Id: 'SampleQueueNotification',
                            Events: ['s3:ObjectCreated:*'],
                            Filter: {
                                Key: {
                                    FilterRules: [
                                        {
                                            Name: 'prefix',
                                            Value: 'CategoryA/',
                                        },
                                    ],
                                },
                            },
                            QueueArn: queue.queueArn,
                        },
                    ],
                },
            },
        });

        // =====================================================================
        // BStack portion: SNS topic + CustomResource for CategoryB/ prefix
        // =====================================================================

        const topic = new sns.Topic(this, 'S3EventTopic');
        topic.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Grant S3 permission to publish to the topic
        topic.grantPublish(new iam.ServicePrincipal('s3.amazonaws.com', {
            conditions: {
                ArnLike: {
                    'aws:SourceArn': bucket.bucketArn,
                },
            },
        }));

        new cdk.CustomResource(this, 'SampleBucketNotificationB', {
            serviceToken: provider.serviceToken,
            properties: {
                BucketName: bucket.bucketName,
                NotificationConfiguration: {
                    TopicConfigurations: [
                        {
                            Id: 'SampleSnsNotification',
                            Events: ['s3:ObjectCreated:*'],
                            Filter: {
                                Key: {
                                    FilterRules: [
                                        {
                                            Name: 'prefix',
                                            Value: 'CategoryB/',
                                        },
                                    ],
                                },
                            },
                            TopicArn: topic.topicArn,
                        },
                    ],
                },
            },
        });

        // Exports
        StackUtils.exportStack(this, 'BucketName', bucket.bucketName, 'S3 bucket name');
        StackUtils.exportStack(this, 'BucketArn', bucket.bucketArn, 'S3 bucket ARN');
        StackUtils.exportStack(this, 'QueueUrl', queue.queueUrl, 'SQS queue URL');
        StackUtils.exportStack(this, 'QueueArn', queue.queueArn, 'SQS queue ARN');
        StackUtils.exportStack(this, 'QueueName', queue.queueName, 'SQS queue name');
        StackUtils.exportStack(this, 'TopicArn', topic.topicArn, 'SNS topic ARN');
        StackUtils.exportStack(this, 'TopicName', topic.topicName, 'SNS topic name');
        StackUtils.exportStack(this, 'FunctionName', notificationManagerFn.functionName, 'Lambda function name');
        StackUtils.exportStack(this, 'NotificationManagerFunctionArn', notificationManagerFn.functionArn, 'Notification manager Lambda function ARN');
    }
}
