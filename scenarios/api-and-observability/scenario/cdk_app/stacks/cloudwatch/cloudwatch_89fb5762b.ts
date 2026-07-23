import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';
import * as path from 'path';

export class CloudWatch_89fb5762b extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // --- VPC ---
        const vpc = ec2.Vpc.fromLookup(this, 'DefaultVPC', { isDefault: true });

        // --- ECS ---
        const taskLogGroup = new logs.LogGroup(this, 'TaskLogGroup', {
            logGroupName: 'FlintMotionDetectionStack-ap-southeast-1',
            retention: logs.RetentionDays.FOUR_MONTHS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const cluster = new ecs.Cluster(this, 'FlintMotionDetectionCluster', {
            clusterName: 'FlintMotionDetectionCluster',
            vpc: vpc,
            containerInsights: true,
        });

        const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
            ],
        });

        const taskRole = new iam.Role(this, 'TaskRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });

        const latencyModeParam = new ssm.StringParameter(this, 'QuartzLatencyMode', {
            parameterName: '/flint/prod/quartz-latency-mode',
            stringValue: 'healthy',
            description: 'Controls simulated Quartz API latency mode for the motion detection task',
        });

        const publishDepMetricsParam = new ssm.StringParameter(this, 'PublishDependencyMetrics', {
            parameterName: '/flint/prod/publish-dependency-metrics',
            stringValue: 'true',
            description: 'Controls whether Flint/Dependencies Quartz API latency metrics are published',
        });

        taskRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['cloudwatch:PutMetricData'],
            resources: ['*'],
        }));
        taskRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
            resources: ['*'],
        }));
        taskRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ssm:GetParameter'],
            resources: [latencyModeParam.parameterArn, publishDepMetricsParam.parameterArn],
        }));

        const taskDefinition = new ecs.FargateTaskDefinition(this, 'MotionDetectionTaskDefinition', {
            family: 'flint-motion-detection-task',
            cpu: 256,
            memoryLimitMiB: 512,
            taskRole: taskRole,
            executionRole: taskExecutionRole,
        });

        taskDefinition.addContainer('HLSProcess', {
            containerName: 'HLSProcess',
            image: ecs.ContainerImage.fromAsset(path.join(__dirname, '../../assets/motion-detection-task')),
            cpu: 256,
            memoryLimitMiB: 512,
            essential: true,
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'HLSProcess/container',
                logGroup: taskLogGroup,
            }),
            environment: {
                AWS_REGION: this.region,
                CLUSTER_NAME: 'Basalt',
                STAGE: 'prod',
                QUARTZ_LATENCY_MODE_PARAM: latencyModeParam.parameterName,
                PUBLISH_DEP_METRICS_PARAM: publishDepMetricsParam.parameterName,
            },
        });

        const fargateSecurityGroup = new ec2.SecurityGroup(this, 'FargateSecurityGroup', {
            vpc: vpc,
            description: 'Security group for Flint motion detection Fargate tasks',
            allowAllOutbound: true,
        });

        const fargateService = new ecs.FargateService(this, 'MotionDetectionService', {
            serviceName: 'flint-motion-detection-service',
            cluster: cluster,
            taskDefinition: taskDefinition,
            desiredCount: 1,
            assignPublicIp: true,
            securityGroups: [fargateSecurityGroup],
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
            platformVersion: ecs.FargatePlatformVersion.LATEST,
        });

        // --- Lambda + SQS ---
        const quartzBackfillDlq = new sqs.Queue(this, 'QuartzBackfillDlq', {
            queueName: 'quartzBackfillQueueDlq',
            retentionPeriod: cdk.Duration.days(14),
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const quartzBackfillQueue = new sqs.Queue(this, 'QuartzBackfillQueue', {
            queueName: 'quartzBackfillQueue',
            deadLetterQueue: { queue: quartzBackfillDlq, maxReceiveCount: 3 },
            retentionPeriod: cdk.Duration.days(14),
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const quartzBackfillFunction = new lambda.Function(this, 'QuartzBackfillFunction', {
            functionName: 'QuartzBackfill',
            runtime: lambda.Runtime.PYTHON_3_11,
            handler: 'index.lambda_handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/quartz-backfill')),
            memorySize: 1280,
            timeout: cdk.Duration.minutes(5),
            environment: {
                QUARTZ_BACKFILL_QUEUE: quartzBackfillQueue.queueName,
                QUARTZ_BACKFILL_DLQ: quartzBackfillDlq.queueName,
                STAGE: 'prod',
                CLUSTER: 'Basalt',
            },
            logRetention: logs.RetentionDays.FOUR_MONTHS,
        });

        quartzBackfillQueue.grantConsumeMessages(quartzBackfillFunction);
        quartzBackfillDlq.grantConsumeMessages(quartzBackfillFunction);

        const rule = new events.Rule(this, 'QuartzBackfillSchedule', {
            schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
        });
        rule.addTarget(new targets.LambdaFunction(quartzBackfillFunction, {
            event: events.RuleTargetInput.fromObject({
                isPulling: 'True',
                queueName: 'quartzBackfillQueueDlq',
            }),
        }));

        // --- CloudWatch Alarm + Dashboard ---
        const serviceLatencyAlarm = new cloudwatch.Alarm(this, 'ServiceLatencyAlarm', {
            alarmName: 'flint-prod-service-latency',
            alarmDescription: 'P90 time, in milliseconds, from initial frame processing to reporting an object to Quartz',
            metric: new cloudwatch.Metric({
                namespace: 'Flint',
                metricName: 'Time',
                dimensionsMap: { Camera_name: 'ALL', Operation: 'FrameQuartzLag' },
                statistic: 'p90',
                period: cdk.Duration.minutes(1),
                unit: cloudwatch.Unit.MILLISECONDS,
            }),
            threshold: 15000,
            evaluationPeriods: 3,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        const frameQuartzLagMetric = new cloudwatch.Metric({
            namespace: 'Flint', metricName: 'Time',
            dimensionsMap: { Camera_name: 'ALL', Operation: 'FrameQuartzLag' },
            statistic: 'p90', period: cdk.Duration.minutes(1), label: 'FrameQuartzLag (P90)',
        });
        const processFrameMetric = new cloudwatch.Metric({
            namespace: 'Flint', metricName: 'Time',
            dimensionsMap: { Camera_name: 'ALL', Operation: 'ProcessFrame' },
            statistic: 'p90', period: cdk.Duration.minutes(1), label: 'ProcessFrame (P90)',
        });
        const motionDetectionMetric = new cloudwatch.Metric({
            namespace: 'Flint', metricName: 'Time',
            dimensionsMap: { Camera_name: 'ALL', Operation: 'MotionDetection' },
            statistic: 'p90', period: cdk.Duration.minutes(1), label: 'MotionDetection (P90)',
        });
        const hlsStartLagMetric = new cloudwatch.Metric({
            namespace: 'Flint', metricName: 'Time',
            dimensionsMap: { Camera_name: 'ALL', Operation: 'HLSStartLag' },
            statistic: 'p90', period: cdk.Duration.minutes(1), label: 'HLSStartLag (P90)',
        });
        const internalPipelineMetric = new cloudwatch.Metric({
            namespace: 'Flint', metricName: 'Time',
            dimensionsMap: { Camera_name: 'ALL', Operation: 'InternalPipelineTime' },
            statistic: 'p90', period: cdk.Duration.minutes(1), label: 'Internal Pipeline Time (P90)',
        });
        const quartzApiLatencyMetric = new cloudwatch.Metric({
            namespace: 'Flint/Dependencies', metricName: 'APILatency',
            dimensionsMap: { Service: 'Quartz', Operation: 'ReportPerson' },
            statistic: 'Average', period: cdk.Duration.minutes(1), label: 'Quartz API Latency (Avg)',
        });
        const cpuMetric = new cloudwatch.Metric({
            namespace: 'Flint', metricName: 'NonIdlePct',
            dimensionsMap: { Camera_name: 'ALL', Operation: 'CPU' },
            statistic: 'p90', period: cdk.Duration.minutes(1), label: 'CPU Utilization (P90)',
        });

        const dashboard = new cloudwatch.Dashboard(this, 'FlintMotionDetectionDashboard', {
            dashboardName: 'FlintMotionDetection-ap-southeast-1',
        });

        dashboard.addWidgets(
            new cloudwatch.GraphWidget({
                title: 'End-to-End Latency vs Threshold',
                left: [frameQuartzLagMetric],
                leftAnnotations: [{ value: 15000, label: 'Alarm Threshold (15s)', color: cloudwatch.Color.RED }],
                width: 24, height: 6,
            })
        );
        dashboard.addWidgets(
            new cloudwatch.GraphWidget({
                title: 'Internal Pipeline Components',
                left: [processFrameMetric, motionDetectionMetric, hlsStartLagMetric, internalPipelineMetric],
                width: 12, height: 6,
            }),
            new cloudwatch.GraphWidget({
                title: 'External Dependency Latency',
                left: [quartzApiLatencyMetric],
                leftAnnotations: [{ value: 15000, label: 'Expected Max (15s)', color: cloudwatch.Color.ORANGE }],
                width: 12, height: 6,
            })
        );
        dashboard.addWidgets(
            new cloudwatch.GraphWidget({
                title: 'Latency Breakdown: Internal vs External',
                left: [internalPipelineMetric], right: [quartzApiLatencyMetric],
                width: 24, height: 6,
            })
        );
        dashboard.addWidgets(
            new cloudwatch.GraphWidget({
                title: 'ECS Service Health',
                left: [cpuMetric], width: 12, height: 6,
            }),
            new cloudwatch.SingleValueWidget({
                title: 'Service Latency Alarm Status',
                metrics: [frameQuartzLagMetric], width: 12, height: 6,
            })
        );

        // --- Outputs ---
        StackUtils.exportStack(this, 'ClusterName', cluster.clusterName, 'ECS Cluster Name');
        StackUtils.exportStack(this, 'ServiceName', fargateService.serviceName, 'ECS Service Name');
        StackUtils.exportStack(this, 'TaskLogGroupName', taskLogGroup.logGroupName, 'Task Log Group Name');
        StackUtils.exportStack(this, 'TaskDefinitionArn', taskDefinition.taskDefinitionArn, 'Task Definition ARN');
        StackUtils.exportStack(this, 'QuartzLatencyModeParamName', latencyModeParam.parameterName, 'SSM parameter name for Quartz latency mode');
        StackUtils.exportStack(this, 'PublishDepMetricsParamName', publishDepMetricsParam.parameterName, 'SSM parameter name for dependency metrics publishing');
        StackUtils.exportStack(this, 'QuartzBackfillFunctionName', quartzBackfillFunction.functionName, 'Quartz Backfill Lambda Function Name');
        StackUtils.exportStack(this, 'QuartzBackfillFunctionArn', quartzBackfillFunction.functionArn, 'Quartz Backfill Lambda Function ARN');
        StackUtils.exportStack(this, 'QuartzBackfillQueueUrl', quartzBackfillQueue.queueUrl, 'Quartz Backfill Queue URL');
        StackUtils.exportStack(this, 'QuartzBackfillDlqUrl', quartzBackfillDlq.queueUrl, 'Quartz Backfill DLQ URL');
        StackUtils.exportStack(this, 'ServiceLatencyAlarmName', serviceLatencyAlarm.alarmName, 'Service Latency Alarm Name');
        StackUtils.exportStack(this, 'ServiceLatencyAlarmArn', serviceLatencyAlarm.alarmArn, 'Service Latency Alarm ARN');
        StackUtils.exportStack(this, 'DashboardName', dashboard.dashboardName, 'CloudWatch Dashboard Name');
    }
}
