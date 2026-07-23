import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import { StackUtils } from '../../lib/shared';

export class S3SnsLambdaChainStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // Dead Letter Queue
        const deadLetterQueue = new sqs.Queue(this, 'CsvUploadDeadLetterQueue', {
            queueName: 'CsvUploadDeadLetterQueue',
            retentionPeriod: cdk.Duration.days(7),
        });
        deadLetterQueue.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Main SQS Queue with DLQ
        const queue = new sqs.Queue(this, 'CsvUploadQueue', {
            queueName: 'CsvUploadQueue',
            visibilityTimeout: cdk.Duration.seconds(30),
            deadLetterQueue: {
                queue: deadLetterQueue,
                maxReceiveCount: 1,
            },
        });
        queue.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // SNS Topic
        const topic = new sns.Topic(this, 'CsvUploadTopic', {
            topicName: 'CsvUploadTopic',
        });
        topic.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Subscribe SQS to SNS with raw message delivery
        topic.addSubscription(new snsSubscriptions.SqsSubscription(queue, {
            rawMessageDelivery: true,
        }));

        // S3 Bucket
        const bucket = new s3.Bucket(this, 'CsvUploadBucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

        // S3 event notification for .csv uploads -> SNS
        bucket.addEventNotification(
            s3.EventType.OBJECT_CREATED_PUT,
            new s3n.SnsDestination(topic),
            { suffix: '.csv' },
        );

        // Lambda function to process CSV upload events
        const csvProcessor = new lambda.Function(this, 'CsvProcessorFunction', {
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/s3-csv-processor')),
        });
        csvProcessor.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // SQS event source for Lambda
        csvProcessor.addEventSource(new lambdaEventSources.SqsEventSource(queue));

        // Exports
        StackUtils.exportStack(this, 'BucketName', bucket.bucketName, 'S3 bucket for CSV uploads');
        StackUtils.exportStack(this, 'TopicArn', topic.topicArn, 'SNS topic ARN for CSV upload notifications');
        StackUtils.exportStack(this, 'TopicName', topic.topicName, 'SNS topic name');
        StackUtils.exportStack(this, 'QueueUrl', queue.queueUrl, 'SQS queue URL for CSV processing');
        StackUtils.exportStack(this, 'QueueArn', queue.queueArn, 'SQS queue ARN');
        StackUtils.exportStack(this, 'QueueName', queue.queueName, 'SQS queue name');
        StackUtils.exportStack(this, 'DeadLetterQueueUrl', deadLetterQueue.queueUrl, 'Dead letter queue URL');
        StackUtils.exportStack(this, 'DeadLetterQueueArn', deadLetterQueue.queueArn, 'Dead letter queue ARN');
        StackUtils.exportStack(this, 'FunctionName', csvProcessor.functionName, 'CSV processor Lambda function name');
        StackUtils.exportStack(this, 'EventSuffix', '.csv', 'File suffix that triggers the event chain');
        StackUtils.exportStack(this, 'MaxReceiveCount', '1', 'Max receive count before messages go to DLQ');
    }
}
