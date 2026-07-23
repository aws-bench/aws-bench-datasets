import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import { StackUtils } from '../../lib/shared';
import * as path from 'path';

export class lambda_b0d9783d3 extends cdk.Stack {
    public readonly onyxLambda: lambda.Function;
    public readonly onyxBetaLambda: lambda.Function;
    public readonly bufferTimeoutLambda: lambda.Function;

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // ── DynamoDB tables ──

        const regressionRequestsTable = new dynamodb.Table(this, 'RegressionRequestsTable', {
            tableName: 'BasaltRegressionRequests-alpha',
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        });

        const bulkRegressionRequestsTable = new dynamodb.Table(this, 'BulkRegressionRequestsTable', {
            tableName: 'BulkBasaltRegressionRequests-alpha',
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        });

        const basaltRequestsTable = new dynamodb.Table(this, 'BasaltRequestsTable', {
            tableName: 'BasaltRequests-alpha',
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        });

        const bulkBasaltRequestsTable = new dynamodb.Table(this, 'BulkBasaltRequestsTable', {
            tableName: 'BulkBasaltRequests-alpha',
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        });

        const regressionRequestsBetaTable = new dynamodb.Table(this, 'RegressionRequestsBetaTable', {
            tableName: 'BasaltRegressionRequests-beta',
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        });

        const basaltRequestsBetaTable = new dynamodb.Table(this, 'BasaltRequestsBetaTable', {
            tableName: 'BasaltRequests-beta',
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        });

        const regressionRequestsGammaTable = new dynamodb.Table(this, 'RegressionRequestsGammaTable', {
            tableName: 'BasaltRegressionRequests-gamma',
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        });

        const basaltRequestsGammaTable = new dynamodb.Table(this, 'BasaltRequestsGammaTable', {
            tableName: 'BasaltRequests-gamma',
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        });

        // ── SQS queues ──

        const retryQueue = new sqs.Queue(this, 'RetryQueue', {
            queueName: 'OnyxRetryQueue-alpha',
            visibilityTimeout: cdk.Duration.seconds(1800),
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const dlq = new sqs.Queue(this, 'DLQ', {
            queueName: 'OnyxDLQ-alpha',
            retentionPeriod: cdk.Duration.days(14),
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // ── SNS topics ──

        const errorTopic = new sns.Topic(this, 'ErrorTopic', {
            topicName: 'Basalt-OnyxErrors-alpha',
            displayName: 'Onyx Lambda Error Notifications',
        });

        const skippedRecordsTopic = new sns.Topic(this, 'SkippedRecordsTopic', {
            topicName: 'Basalt-OnyxSkippedRecords-alpha',
            displayName: 'Onyx Lambda Skipped Records Notifications',
        });

        // ── Onyx Lambda (alpha) ──

        const onyxRole = new iam.Role(this, 'OnyxRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            description: 'Execution role for Onyx Lambda handler',
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
            ],
        });

        regressionRequestsTable.grantStreamRead(onyxRole);
        bulkRegressionRequestsTable.grantStreamRead(onyxRole);
        basaltRequestsTable.grantStreamRead(onyxRole);
        bulkBasaltRequestsTable.grantStreamRead(onyxRole);
        regressionRequestsTable.grantReadData(onyxRole);
        bulkRegressionRequestsTable.grantReadData(onyxRole);
        basaltRequestsTable.grantReadData(onyxRole);
        bulkBasaltRequestsTable.grantReadData(onyxRole);
        retryQueue.grantSendMessages(onyxRole);
        retryQueue.grantConsumeMessages(onyxRole);
        dlq.grantSendMessages(onyxRole);
        errorTopic.grantPublish(onyxRole);
        skippedRecordsTopic.grantPublish(onyxRole);

        onyxRole.addToPolicy(new iam.PolicyStatement({
            actions: ['cloudwatch:PutMetricData'],
            resources: ['*'],
        }));

        this.onyxLambda = new lambda.Function(this, 'OnyxFunction', {
            functionName: 'Basalt-OnyxHandler-alpha',
            runtime: lambda.Runtime.PYTHON_3_10,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/onyx_handler')),
            timeout: cdk.Duration.seconds(300),
            memorySize: 512,
            role: onyxRole,
            environment: {
                LOGLEVEL: '10',
                STAGE: 'alpha',
                BASALT_REQUESTS_TABLE: basaltRequestsTable.tableName,
                BULK_BASALT_REQUESTS_TABLE: bulkBasaltRequestsTable.tableName,
                ONYX_ERROR_SNS_TOPIC_ARN: errorTopic.topicArn,
                ONYX_RETRY_QUEUE_URL: retryQueue.queueUrl,
                ONYX_DLQ_URL: dlq.queueUrl,
                ONYX_SKIPPED_RECORDS_TOPIC_ARN: skippedRecordsTopic.topicArn,
            },
            description: 'Lambda function for Onyx integration - processes DynamoDB streams to trigger Quartz tests - alpha stage',
            logRetention: logs.RetentionDays.TEN_YEARS,
            deadLetterQueue: dlq,
        });

        this.onyxLambda.addEventSource(
            new lambdaEventSources.DynamoEventSource(regressionRequestsTable, {
                startingPosition: lambda.StartingPosition.LATEST,
                batchSize: 1,
                retryAttempts: 3,
            })
        );
        this.onyxLambda.addEventSource(
            new lambdaEventSources.DynamoEventSource(bulkRegressionRequestsTable, {
                startingPosition: lambda.StartingPosition.LATEST,
                batchSize: 1,
                retryAttempts: 3,
            })
        );
        this.onyxLambda.addEventSource(
            new lambdaEventSources.DynamoEventSource(basaltRequestsTable, {
                startingPosition: lambda.StartingPosition.LATEST,
                batchSize: 1,
                retryAttempts: 3,
            })
        );
        this.onyxLambda.addEventSource(
            new lambdaEventSources.DynamoEventSource(bulkBasaltRequestsTable, {
                startingPosition: lambda.StartingPosition.LATEST,
                batchSize: 1,
                retryAttempts: 3,
            })
        );
        this.onyxLambda.addEventSource(
            new lambdaEventSources.SqsEventSource(retryQueue, {
                batchSize: 1,
            })
        );

        // ── CloudWatch alarm ──

        const skippedRecordsMetric = new cloudwatch.Metric({
            namespace: 'Basalt/Onyx',
            metricName: 'SkippedRecords',
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
        });

        const skippedRecordsAlarm = new cloudwatch.Alarm(this, 'SkippedRecordsAlarm', {
            alarmName: 'Basalt-OnyxSkippedRecords-alpha',
            alarmDescription: 'Alert when Onyx Lambda skips records - may indicate filter logic issue',
            metric: skippedRecordsMetric,
            threshold: 5,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        });

        skippedRecordsAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(skippedRecordsTopic));

        // ── Onyx Lambda (beta) ──

        const onyxBetaRole = new iam.Role(this, 'OnyxBetaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            description: 'Execution role for Onyx Lambda handler - beta',
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
            ],
        });

        regressionRequestsBetaTable.grantStreamRead(onyxBetaRole);
        basaltRequestsBetaTable.grantStreamRead(onyxBetaRole);
        regressionRequestsBetaTable.grantReadData(onyxBetaRole);
        basaltRequestsBetaTable.grantReadData(onyxBetaRole);

        this.onyxBetaLambda = new lambda.Function(this, 'OnyxBetaFunction', {
            functionName: 'Basalt-OnyxHandler-beta',
            runtime: lambda.Runtime.PYTHON_3_10,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/onyx_handler_beta')),
            timeout: cdk.Duration.seconds(300),
            memorySize: 512,
            role: onyxBetaRole,
            environment: {
                LOGLEVEL: '20',
                STAGE: 'beta',
            },
            description: 'Lambda function for Onyx integration - beta stage',
            logRetention: logs.RetentionDays.ONE_YEAR,
        });

        this.onyxBetaLambda.addEventSource(
            new lambdaEventSources.DynamoEventSource(regressionRequestsBetaTable, {
                startingPosition: lambda.StartingPosition.LATEST,
                batchSize: 1,
                retryAttempts: 3,
            })
        );
        this.onyxBetaLambda.addEventSource(
            new lambdaEventSources.DynamoEventSource(basaltRequestsBetaTable, {
                startingPosition: lambda.StartingPosition.LATEST,
                batchSize: 1,
                retryAttempts: 3,
            })
        );

        // ── Buffer Timeout Lambda ──

        const bufferTimeoutRole = new iam.Role(this, 'BufferTimeoutRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            description: 'Execution role for Buffer Timeout handler',
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
            ],
        });

        regressionRequestsTable.grantReadWriteData(bufferTimeoutRole);
        bulkRegressionRequestsTable.grantReadWriteData(bufferTimeoutRole);
        basaltRequestsTable.grantReadWriteData(bufferTimeoutRole);
        bulkBasaltRequestsTable.grantReadWriteData(bufferTimeoutRole);

        this.bufferTimeoutLambda = new lambda.Function(this, 'BufferTimeoutFunction', {
            functionName: 'Basalt-BufferTimeout-alpha',
            runtime: lambda.Runtime.PYTHON_3_10,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/buffer_timeout_handler')),
            timeout: cdk.Duration.seconds(90),
            memorySize: 256,
            role: bufferTimeoutRole,
            environment: {
                LOGLEVEL: '10',
                STAGE: 'alpha',
                REGRESSION_REQUESTS_TABLE: regressionRequestsTable.tableName,
                BASALT_REQUESTS_TABLE: basaltRequestsTable.tableName,
            },
            description: 'Lambda function for handling buffer timeout transitions - alpha stage',
            logRetention: logs.RetentionDays.ONE_YEAR,
        });

        // ── Exports: DynamoDB ──

        StackUtils.exportStack(this, 'RegressionRequestsTableName', regressionRequestsTable.tableName, 'BasaltRegressionRequests-alpha table name');
        StackUtils.exportStack(this, 'RegressionRequestsStreamArn', regressionRequestsTable.tableStreamArn!, 'BasaltRegressionRequests-alpha stream ARN');
        StackUtils.exportStack(this, 'BulkRegressionRequestsTableName', bulkRegressionRequestsTable.tableName, 'BulkBasaltRegressionRequests-alpha table name');
        StackUtils.exportStack(this, 'BulkRegressionRequestsStreamArn', bulkRegressionRequestsTable.tableStreamArn!, 'BulkBasaltRegressionRequests-alpha stream ARN');
        StackUtils.exportStack(this, 'BasaltRequestsTableName', basaltRequestsTable.tableName, 'BasaltRequests-alpha table name');
        StackUtils.exportStack(this, 'BasaltRequestsStreamArn', basaltRequestsTable.tableStreamArn!, 'BasaltRequests-alpha stream ARN');
        StackUtils.exportStack(this, 'BulkBasaltRequestsTableName', bulkBasaltRequestsTable.tableName, 'BulkBasaltRequests-alpha table name');
        StackUtils.exportStack(this, 'BulkBasaltRequestsStreamArn', bulkBasaltRequestsTable.tableStreamArn!, 'BulkBasaltRequests-alpha stream ARN');
        StackUtils.exportStack(this, 'RegressionRequestsBetaTableName', regressionRequestsBetaTable.tableName, 'BasaltRegressionRequests-beta table name');
        StackUtils.exportStack(this, 'BasaltRequestsBetaTableName', basaltRequestsBetaTable.tableName, 'BasaltRequests-beta table name');
        StackUtils.exportStack(this, 'RegressionRequestsGammaTableName', regressionRequestsGammaTable.tableName, 'BasaltRegressionRequests-gamma table name');
        StackUtils.exportStack(this, 'BasaltRequestsGammaTableName', basaltRequestsGammaTable.tableName, 'BasaltRequests-gamma table name');

        // ── Exports: Lambda ──

        StackUtils.exportStack(this, 'OnyxFunctionName', this.onyxLambda.functionName, 'Onyx Lambda function name');
        StackUtils.exportStack(this, 'OnyxFunctionArn', this.onyxLambda.functionArn, 'Onyx Lambda function ARN');
        StackUtils.exportStack(this, 'OnyxLogGroup', this.onyxLambda.logGroup.logGroupName, 'Onyx Lambda log group name');
        StackUtils.exportStack(this, 'RetryQueueUrl', retryQueue.queueUrl, 'Onyx retry queue URL');
        StackUtils.exportStack(this, 'DLQUrl', dlq.queueUrl, 'Onyx DLQ URL');
        StackUtils.exportStack(this, 'ErrorTopicArn', errorTopic.topicArn, 'Onyx error topic ARN');
        StackUtils.exportStack(this, 'SkippedRecordsTopicArn', skippedRecordsTopic.topicArn, 'Onyx skipped records topic ARN');
        StackUtils.exportStack(this, 'SkippedRecordsAlarmName', skippedRecordsAlarm.alarmName, 'Onyx skipped records alarm name');
        StackUtils.exportStack(this, 'OnyxBetaFunctionName', this.onyxBetaLambda.functionName, 'Onyx Lambda function name - beta');
        StackUtils.exportStack(this, 'BufferTimeoutFunctionName', this.bufferTimeoutLambda.functionName, 'Buffer Timeout Lambda function name');
    }
}
