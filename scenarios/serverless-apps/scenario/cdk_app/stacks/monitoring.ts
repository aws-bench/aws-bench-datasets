import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import { Construct } from 'constructs';
import { StackUtils } from '../lib/shared';

export class MonitoringStack extends cdk.Stack {

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // CloudWatch Dashboard
        const dashboard = new cloudwatch.Dashboard(this, 'MyDashboard', {
            dashboardName: 'MyServiceMetrics',
        });

        dashboard.addWidgets(
            new cloudwatch.GraphWidget({
                title: 'NAT Gateway Metrics',
                left: [
                    new cloudwatch.Metric({
                        namespace: 'AWS/ECS',
                        metricName: 'MemoryUtilization',
                        dimensionsMap: {
                            ClusterName: 'placeholder',
                        },
                    }),
                ],
            }),
            new cloudwatch.GraphWidget({
                title: 'Lambda Function Metrics',
                left: [
                    new cloudwatch.Metric({
                        namespace: 'AWS/Lambda',
                        metricName: 'Invocations',
                        dimensionsMap: {
                            FunctionName: 'my-data-exporter',
                        },
                    }),
                ],
            }),
            new cloudwatch.GraphWidget({
                title: 'ECS Cluster Metrics',
                left: [
                    new cloudwatch.Metric({
                        namespace: 'AWS/ECS',
                        metricName: 'CPUUtilization',
                        dimensionsMap: {
                            ClusterName: 'placeholder',
                        },
                    }),
                ],
            }),
        );

        // Firehose Destination Bucket
        const firehoseDestinationBucket = new s3.Bucket(this, 'FirehoseDestinationBucket', {
            bucketName: `my-firehose-destination-bucket-${this.account}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            autoDeleteObjects: true,
        });

        // Harden the autoDeleteObjects handler with identity-based S3 grants.
        // By default the handler role's ONLY S3 access is the grant the bucket
        // policy gives its exact role ARN. If that grant is stale or gone at
        // delete time, the handler fails its first call (s3:GetBucketTagging)
        // with AccessDenied, the stack delete force-abandons this FIXED-NAME
        // bucket, and every later deploy fails changeset validation with
        // "already exists" — an unrecoverable reset->redeploy loop. Granting
        // the role directly removes the dependence on bucket-policy survival.
        const autoDeleteProvider = this.node.tryFindChild(
            'Custom::S3AutoDeleteObjectsCustomResourceProvider',
        ) as cdk.CustomResourceProviderBase | undefined;
        autoDeleteProvider?.addToRolePolicy({
            Effect: 'Allow',
            Action: ['s3:GetBucket*', 's3:List*', 's3:DeleteObject*', 's3:PutBucketPolicy'],
            Resource: [
                firehoseDestinationBucket.bucketArn,
                `${firehoseDestinationBucket.bucketArn}/*`,
            ],
        });

        // IAM Role for Firehose
        const firehoseRole = new iam.Role(this, 'FirehoseRole', {
            assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
        });
        firehoseDestinationBucket.grantReadWrite(firehoseRole);

        // Firehose Delivery Stream
        const firehoseDeliveryStreamName = 'MyFirehoseDeliveryStream';
        const firehoseDeliveryStream = new firehose.CfnDeliveryStream(this, firehoseDeliveryStreamName, {
            deliveryStreamName: firehoseDeliveryStreamName,
            s3DestinationConfiguration: {
                bucketArn: firehoseDestinationBucket.bucketArn,
                bufferingHints: {
                    intervalInSeconds: 60,
                    sizeInMBs: 1,
                },
                compressionFormat: 'GZIP',
                roleArn: firehoseRole.roleArn,
            },
        });

        // Metric Stream Role (standard)
        const metricStreamRole = new iam.Role(this, 'MetricStreamRole', {
            assumedBy: new iam.ServicePrincipal('streams.metrics.cloudwatch.amazonaws.com'),
        });

        metricStreamRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'],
                resources: [firehoseDeliveryStream.attrArn],
            }),
        );

        // Metric Stream 95 Role
        const metricStream95Role = new iam.Role(this, 'MetricStream95Role', {
            assumedBy: new iam.ServicePrincipal('cloudwatch.amazonaws.com'),
        });

        metricStream95Role.addToPolicy(
            new iam.PolicyStatement({
                actions: [
                    'firehose:PutRecord',
                    'firehose:PutRecordBatch',
                    's3:PutObject',
                    's3:GetBucketAcl',
                    's3:GetBucketPolicy',
                ],
                resources: ['*'],
            }),
        );

        // Metric Stream with 95% filter
        const metricStream95 = new cloudwatch.CfnMetricStream(this, 'MetricStream95', {
            firehoseArn: firehoseDeliveryStream.attrArn,
            roleArn: metricStream95Role.roleArn,
            includeFilters: [
                {
                    namespace: 'AWS/EC2',
                },
                {
                    namespace: 'AWS/Lambda',
                },
            ],
            outputFormat: 'json',
            statisticsConfigurations: [
                {
                    includeMetrics: [
                        {
                            namespace: 'AWS/EC2',
                            metricName: 'CPUUtilization',
                        },
                        {
                            namespace: 'AWS/Lambda',
                            metricName: 'Duration',
                        },
                    ],
                    additionalStatistics: ['p95'],
                },
            ],
        });

        // Standard Metric Stream
        const metricStreamName = 'MyCfnMetricStream';
        const metricStream = new cloudwatch.CfnMetricStream(this, metricStreamName, {
            firehoseArn: firehoseDeliveryStream.attrArn,
            outputFormat: 'json',
            roleArn: metricStreamRole.roleArn,
            excludeFilters: [
                {
                    namespace: 'AWS/EC2',
                    metricNames: ['CPUUtilization', 'NetworkIn', 'NetworkOut', 'DiskReadBytes', 'DiskWriteBytes'],
                },
            ],
            statisticsConfigurations: [
                {
                    additionalStatistics: ['p99'],
                    includeMetrics: [
                        {
                            namespace: 'AWS/ECS',
                            metricName: 'CPUUtilization',
                        },
                    ],
                },
            ],
            includeLinkedAccountsMetrics: false,
            name: 'TestEvalStream',
        });
        metricStream.node.addDependency(metricStreamRole);
        metricStream.node.addDependency(firehoseDeliveryStream);

        // Log Group + Log Stream
        const logGroup = new logs.LogGroup(this, 'MyLogGroup', { removalPolicy: cdk.RemovalPolicy.DESTROY });
        const logStream = new logs.LogStream(this, 'MyLogStream', {
            logGroup,
            logStreamName: 'MyLogStream',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // SNS Topic (SensorAlerts)
        const sensorAlerts = new sns.Topic(this, 'my-sensor-alerts', {
            topicName: 'my-sensor-alerts',
        });

        // SQS Queue (AlertQueue)
        const alertQueue = new sqs.Queue(this, 'AlertQueue', {
            queueName: 'my-alert-queue',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Exports
        StackUtils.exportStack(this, 'DashboardName', dashboard.dashboardName);
        StackUtils.exportStack(this, 'DashboardArn', dashboard.dashboardArn);
        StackUtils.exportStack(this, 'MetricStream95Name', metricStream95.attrArn);
        StackUtils.exportStack(this, 'MetricStreamArn', metricStream.attrArn, 'Arn of the CloudWatch Metric Stream');
        StackUtils.exportStack(
            this,
            'MetricStreamName',
            metricStream.name || metricStreamName,
            'Name of the CloudWatch Metric Stream',
        );
        StackUtils.exportStack(
            this,
            'FirehoseDeliveryStreamName',
            firehoseDeliveryStream.deliveryStreamName || firehoseDeliveryStreamName,
            'Name of the Kinesis Firehose Delivery Stream',
        );
        StackUtils.exportStack(
            this,
            'FirehoseDestinationBucketName',
            firehoseDestinationBucket.bucketName,
            'Name of the S3 bucket for Kinesis Firehose destination',
        );
        StackUtils.exportStack(this, 'LogStream', logStream.logStreamName);
        StackUtils.exportStack(this, 'LogGroup', logGroup.logGroupName);
        StackUtils.exportStack(this, 'SensorAlertsTopicName', sensorAlerts.topicName);
        StackUtils.exportStack(this, 'SensorAlertsTopicArn', sensorAlerts.topicArn);
        StackUtils.exportStack(this, 'MyAlertQueueSQSURL', alertQueue.queueUrl);
    }
}
