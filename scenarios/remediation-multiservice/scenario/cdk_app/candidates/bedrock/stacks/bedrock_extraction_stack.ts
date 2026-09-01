import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { StackUtils } from '../lib/shared';

/**
 * DocIntel structured-extraction service.
 *
 * A single "router" Lambda pulls per-document-class extraction profiles out of
 * DynamoDB, reads the sample document from S3 and calls the Bedrock Converse
 * API with a tool definition so the model returns structured JSON. Every
 * profile flows through exactly the same code path; only the model id and the
 * per-profile routingStrategy differ between profiles.
 *
 * Outcomes (status / stopReason / provider error) are persisted to a runs
 * table, and the service publishes its own success/failure counters to
 * CloudWatch so the ops alarm can page on structured-output regressions.
 */
export class BedrockExtractionStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const dep = 'uyvjsf7fj';
        const metricNamespace = 'DocIntel/Extraction';

        // ---------------------------------------------------------------
        // Document store
        // ---------------------------------------------------------------
        const bucketName = `docintel-documents-${dep}-${this.account}-${this.region}`;
        const documents = new s3.Bucket(this, 'DocumentsBucket', {
            bucketName,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            versioned: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            lifecycleRules: [
                {
                    id: 'expire-incoming-after-30-days',
                    prefix: 'incoming/',
                    expiration: cdk.Duration.days(30),
                },
            ],
        });

        // ---------------------------------------------------------------
        // Routing configuration + run ledger
        // ---------------------------------------------------------------
        const profilesTableName = `docintel-extraction-profiles-${dep}`;
        const profiles = new dynamodb.Table(this, 'ProfilesTable', {
            tableName: profilesTableName,
            partitionKey: { name: 'profileId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const runsTableName = `docintel-extraction-runs-${dep}`;
        const runs = new dynamodb.Table(this, 'RunsTable', {
            tableName: runsTableName,
            partitionKey: { name: 'profileId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'runId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: 'expiresAt',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        runs.addGlobalSecondaryIndex({
            indexName: 'status-startedAt-index',
            partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'startedAt', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // ---------------------------------------------------------------
        // Async failure sink for S3-triggered invocations
        // ---------------------------------------------------------------
        const dlqName = `docintel-extraction-dlq-${dep}`;
        const dlq = new sqs.Queue(this, 'RouterDlq', {
            queueName: dlqName,
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            enforceSSL: true,
            retentionPeriod: cdk.Duration.days(4),
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // ---------------------------------------------------------------
        // Router Lambda
        // ---------------------------------------------------------------
        const functionName = `docintel-extraction-router-${dep}`;
        const routerLogGroup = new logs.LogGroup(this, 'RouterLogGroup', {
            logGroupName: `/aws/lambda/${functionName}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const router = new lambda.Function(this, 'RouterFunction', {
            functionName,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../assets/extraction_router')),
            timeout: cdk.Duration.seconds(180),
            memorySize: 512,
            logGroup: routerLogGroup,
            deadLetterQueueEnabled: true,
            deadLetterQueue: dlq,
            retryAttempts: 0,
            environment: {
                PROFILES_TABLE: profilesTableName,
                RUNS_TABLE: runsTableName,
                DOCUMENTS_BUCKET: bucketName,
                METRIC_NAMESPACE: metricNamespace,
                SERVICE_NAME: 'docintel-extraction',
                RUN_TTL_DAYS: '3',
            },
        });

        profiles.grantReadData(router);
        runs.grantReadWriteData(router);
        documents.grantRead(router);

        // Least-privilege Bedrock access: only the models this service routes to,
        // including the foundation-model ARNs in every region the system-defined
        // cross-region inference profiles can fan out to.
        router.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'InvokeRoutedFoundationModels',
                actions: ['bedrock:InvokeModel'],
                resources: [
                    `arn:aws:bedrock:${this.region}::foundation-model/amazon.nova-pro-v1:0`,
                    `arn:aws:bedrock:${this.region}::foundation-model/amazon.nova-lite-v1:0`,
                    `arn:aws:bedrock:${this.region}::foundation-model/mistral.mistral-large-2402-v1:0`,
                    `arn:aws:bedrock:us-east-1::foundation-model/meta.llama3-3-70b-instruct-v1:0`,
                    `arn:aws:bedrock:us-east-2::foundation-model/meta.llama3-3-70b-instruct-v1:0`,
                    `arn:aws:bedrock:us-west-2::foundation-model/meta.llama3-3-70b-instruct-v1:0`,
                    `arn:aws:bedrock:us-east-1::foundation-model/deepseek.r1-v1:0`,
                    `arn:aws:bedrock:us-east-2::foundation-model/deepseek.r1-v1:0`,
                    `arn:aws:bedrock:us-west-2::foundation-model/deepseek.r1-v1:0`,
                ],
            }),
        );
        router.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'InvokeRoutedInferenceProfiles',
                actions: ['bedrock:InvokeModel'],
                resources: [
                    `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.meta.llama3-3-70b-instruct-v1:0`,
                    `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.deepseek.r1-v1:0`,
                ],
            }),
        );
        router.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'PublishServiceMetrics',
                actions: ['cloudwatch:PutMetricData'],
                resources: ['*'],
                conditions: { StringEquals: { 'cloudwatch:namespace': metricNamespace } },
            }),
        );

        // Newly dropped documents are routed by key prefix: incoming/<profileId>/<file>
        documents.addEventNotification(
            s3.EventType.OBJECT_CREATED,
            new s3n.LambdaDestination(router),
            { prefix: 'incoming/', suffix: '.txt' },
        );

        // ---------------------------------------------------------------
        // Alerting
        // ---------------------------------------------------------------
        const topicName = `docintel-extraction-alerts-${dep}`;
        const alerts = new sns.Topic(this, 'AlertsTopic', {
            topicName,
            displayName: 'DocIntel extraction alerts',
            enforceSSL: true,
        });

        const alertsQueueName = `docintel-extraction-alerts-inbox-${dep}`;
        const alertsQueue = new sqs.Queue(this, 'AlertsInbox', {
            queueName: alertsQueueName,
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            enforceSSL: true,
            retentionPeriod: cdk.Duration.days(4),
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        alerts.addSubscription(new snsSubs.SqsSubscription(alertsQueue, { rawMessageDelivery: false }));

        const failureAlarmName = `docintel-extraction-failures-${dep}`;
        const failureAlarm = new cloudwatch.Alarm(this, 'ExtractionFailureAlarm', {
            alarmName: failureAlarmName,
            alarmDescription:
                'DocIntel extraction produced no structured output for one or more document classes.',
            metric: new cloudwatch.Metric({
                namespace: metricNamespace,
                metricName: 'ExtractionFailures',
                statistic: cloudwatch.Stats.SUM,
                period: cdk.Duration.minutes(1),
            }),
            threshold: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
            treatMissingData: cloudwatch.TreatMissingData.MISSING,
        });
        failureAlarm.addAlarmAction(new cwActions.SnsAction(alerts));

        // The handler catches provider errors and records them, so the Lambda itself
        // never faults.
        const invokeAlarmName = `docintel-extraction-router-invoke-errors-${dep}`;
        const invokeAlarm = new cloudwatch.Alarm(this, 'RouterInvokeErrorAlarm', {
            alarmName: invokeAlarmName,
            alarmDescription: 'docintel-extraction-router Lambda invocation errors.',
            metric: router.metricErrors({ period: cdk.Duration.minutes(1), statistic: cloudwatch.Stats.SUM }),
            threshold: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        invokeAlarm.addAlarmAction(new cwActions.SnsAction(alerts));

        // ---------------------------------------------------------------
        // Outputs (literal values only, so re-deploys stay stable)
        // ---------------------------------------------------------------
        StackUtils.exportStack(this, 'FunctionName', functionName, 'Extraction router Lambda function name');
        StackUtils.exportStack(this, 'LogGroupName', `/aws/lambda/${functionName}`, 'Extraction router log group');
        StackUtils.exportStack(this, 'ProfilesTableName', profilesTableName, 'Extraction profile routing table');
        StackUtils.exportStack(this, 'RunsTableName', runsTableName, 'Extraction run ledger table');
        StackUtils.exportStack(this, 'DocumentsBucketName', bucketName, 'Document store bucket');
        StackUtils.exportStack(this, 'AlarmName', failureAlarmName, 'Structured-output failure alarm');
        StackUtils.exportStack(this, 'InvokeErrorAlarmName', invokeAlarmName, 'Router invocation error alarm');
        StackUtils.exportStack(this, 'MetricNamespace', metricNamespace, 'CloudWatch namespace for service metrics');
        StackUtils.exportStack(this, 'AlertsTopicName', topicName, 'SNS topic used by the extraction alarms');
        StackUtils.exportStack(this, 'AlertsInboxQueueName', alertsQueueName, 'SQS queue subscribed to the alert topic');
        StackUtils.exportStack(this, 'DlqName', dlqName, 'Async invocation dead-letter queue');
    }
}
