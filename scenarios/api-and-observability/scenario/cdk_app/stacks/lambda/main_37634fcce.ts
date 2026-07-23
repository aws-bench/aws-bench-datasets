import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as path from 'path';
import { StackUtils } from '../../lib/shared';

interface MainStackProps extends cdk.StackProps {
    analyticsBucket: s3.IBucket;
    archiveBucket: s3.IBucket;
    reportsBucket: s3.IBucket;
    analyticsBucketName: string;
}

export class main_37634fcce extends cdk.Stack {
    constructor(scope: Construct, id: string, props: MainStackProps) {
        super(scope, id, props);

        // ---- VPC ----

        const mainVpc = new ec2.Vpc(this, 'MainVPC', {
            vpcName: 'Quartz-Beta-VPC',
            ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
            maxAzs: 2,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            subnetConfiguration: [
                { name: 'PublicSubnet', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
                { name: 'PrivateSubnet', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
                { name: 'IsolatedSubnet', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
            ],
            natGateways: 1,
        });

        mainVpc.addGatewayEndpoint('S3GatewayEndpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });
        mainVpc.addGatewayEndpoint('DynamoDBGatewayEndpoint', { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB });
        mainVpc.addInterfaceEndpoint('SQSInterfaceEndpoint', { service: ec2.InterfaceVpcEndpointAwsService.SQS, privateDnsEnabled: true });

        const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'ReconciliationProcessorSG', {
            vpc: mainVpc, description: 'Security group for reconciliation processor Lambda', allowAllOutbound: true,
        });
        const processorSecurityGroup = new ec2.SecurityGroup(this, 'AnalyticsProcessorSG', {
            vpc: mainVpc, description: 'Security group for analytics processor Lambda', allowAllOutbound: true,
        });
        const analyticsSecurityGroup = new ec2.SecurityGroup(this, 'AnalyticsWriterSG', {
            vpc: mainVpc, description: 'Security group for analytics writer Lambda', allowAllOutbound: true,
        });

        const devVpc = new ec2.Vpc(this, 'DevVPC', {
            vpcName: 'Quartz-Dev-VPC',
            ipAddresses: ec2.IpAddresses.cidr('10.1.0.0/16'),
            maxAzs: 2,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            subnetConfiguration: [
                { name: 'PublicSubnet', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
                { name: 'PrivateSubnet', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
            ],
            natGateways: 1,
        });
        devVpc.addGatewayEndpoint('DevS3GatewayEndpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });
        const devSecurityGroup = new ec2.SecurityGroup(this, 'DevProcessorSG', {
            vpc: devVpc, description: 'Security group for dev processor Lambda', allowAllOutbound: true,
        });

        // ---- S3 (us-west-2 buckets) ----

        const westKmsKey = new kms.Key(this, 'WestKey', {
            description: 'KMS key for us-west-2 bucket encryption', enableKeyRotation: true, removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const configBucket = new s3.Bucket(this, 'ConfigBucket', {
            bucketName: `quartz-config-beta-${this.account}-us-west-2`,
            versioned: true, encryption: s3.BucketEncryption.KMS, encryptionKey: westKmsKey,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true,
            autoDeleteObjects: true, removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const tempBucket = new s3.Bucket(this, 'TempBucket', {
            bucketName: `quartz-temp-beta-${this.account}-us-west-2`,
            encryption: s3.BucketEncryption.KMS, encryptionKey: westKmsKey,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true,
            autoDeleteObjects: true, removalPolicy: cdk.RemovalPolicy.DESTROY,
            lifecycleRules: [{ expiration: cdk.Duration.days(7) }],
        });

        const backupBucket = new s3.Bucket(this, 'BackupBucket', {
            bucketName: `quartz-backup-beta-${this.account}-us-west-2`,
            versioned: true, encryption: s3.BucketEncryption.KMS, encryptionKey: westKmsKey,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true,
            autoDeleteObjects: true, removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Harden the autoDeleteObjects handler with identity-based S3 grants.
        // By default the handler role's ONLY S3 access is the grant each bucket
        // policy gives its exact role ARN. If that grant is stale or gone at
        // delete time, the handler fails its first call (s3:GetBucketTagging)
        // with AccessDenied, the stack delete force-abandons these FIXED-NAME
        // buckets, and every later deploy fails changeset validation with
        // "already exists" — an unrecoverable reset->redeploy loop. Granting
        // the role directly removes the dependence on bucket-policy survival.
        const autoDeleteProvider = this.node.tryFindChild(
            'Custom::S3AutoDeleteObjectsCustomResourceProvider',
        ) as cdk.CustomResourceProviderBase | undefined;
        autoDeleteProvider?.addToRolePolicy({
            Effect: 'Allow',
            Action: ['s3:GetBucket*', 's3:List*', 's3:DeleteObject*', 's3:PutBucketPolicy'],
            Resource: [
                configBucket.bucketArn,
                `${configBucket.bucketArn}/*`,
                tempBucket.bucketArn,
                `${tempBucket.bucketArn}/*`,
                backupBucket.bucketArn,
                `${backupBucket.bucketArn}/*`,
            ],
        });

        // ---- SQS ----

        const sqsKmsKey = new kms.Key(this, 'SQSKey', {
            description: 'KMS key for SQS queue encryption', enableKeyRotation: true, removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const dlq = new sqs.Queue(this, 'DLQ', {
            queueName: 'quartz-reconciliation-request-dlq-beta',
            encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: sqsKmsKey,
            retentionPeriod: cdk.Duration.days(14), removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const inputQueue = new sqs.Queue(this, 'InputQueue', {
            queueName: 'quartz-reconciliation-request-beta',
            visibilityTimeout: cdk.Duration.seconds(600), retentionPeriod: cdk.Duration.days(14),
            encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: sqsKmsKey,
            deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const outputQueue = new sqs.Queue(this, 'OutputQueue', {
            queueName: 'quartz-reconciliation-response-beta',
            visibilityTimeout: cdk.Duration.seconds(300), retentionPeriod: cdk.Duration.days(14),
            encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: sqsKmsKey,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // ---- Lambda: main reconciliation processor ----

        const reconciliationRole = new iam.Role(this, 'ReconciliationRole', {
            roleName: 'Quartz-Beta-Security-LambdaRole',
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')],
        });
        reconciliationRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW, actions: ['s3:PutObject', 's3:GetObject'],
            resources: [`${props.analyticsBucket.bucketArn}/*`, `${props.archiveBucket.bucketArn}/*`, `${props.reportsBucket.bucketArn}/*`],
        }));
        reconciliationRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW, actions: ['sqs:*'], resources: [outputQueue.queueArn, inputQueue.queueArn],
        }));
        reconciliationRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW, actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'], resources: ['*'],
        }));

        const reconciliationLogGroup = new logs.LogGroup(this, 'ReconciliationLogGroup', {
            logGroupName: '/aws/lambda/quartz-reconciliation-processor-beta',
            retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const reconciliationFunction = new lambda.Function(this, 'ReconciliationProcessor', {
            functionName: 'quartz-reconciliation-processor-beta',
            runtime: lambda.Runtime.PYTHON_3_11, handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/reconciliation-processor')),
            timeout: cdk.Duration.seconds(600), memorySize: 2048,
            role: reconciliationRole, vpc: mainVpc,
            vpcSubnets: { subnets: mainVpc.isolatedSubnets },
            securityGroups: [lambdaSecurityGroup],
            environment: {
                INPUT_QUEUE_URL: inputQueue.queueUrl, OUTPUT_QUEUE_URL: outputQueue.queueUrl,
                ANALYTICS_S3_BUCKET: props.analyticsBucketName, ANALYTICS_S3_REGION: 'us-east-1', LOG_LEVEL: 'WARN',
            },
            logGroup: reconciliationLogGroup,
        });
        reconciliationFunction.addEventSource(new lambdaEventSources.SqsEventSource(inputQueue, { batchSize: 1, maxBatchingWindow: cdk.Duration.seconds(0) }));
        inputQueue.grantConsumeMessages(reconciliationFunction);
        outputQueue.grantSendMessages(reconciliationFunction);

        new cloudwatch.Alarm(this, 'ReconciliationTimeoutAlarm', {
            alarmName: 'quartz-reconciliation-timeout-alarm',
            metric: reconciliationFunction.metricDuration({ statistic: 'Maximum' }),
            threshold: 590000, evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        // ---- Lambda: analytics processor ----

        const analyticsProcessorRole = new iam.Role(this, 'AnalyticsProcessorRole', {
            roleName: 'Quartz-Beta-AnalyticsProcessor-Role',
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')],
        });
        analyticsProcessorRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW, actions: ['s3:GetObject', 's3:PutObject'],
            resources: [`${props.analyticsBucket.bucketArn}/*`, `${props.archiveBucket.bucketArn}/*`],
        }));
        analyticsProcessorRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW, actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey'], resources: ['*'],
        }));

        new lambda.Function(this, 'AnalyticsProcessor', {
            functionName: 'quartz-analytics-processor-beta',
            runtime: lambda.Runtime.PYTHON_3_11, handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/analytics-processor')),
            timeout: cdk.Duration.seconds(300), memorySize: 1024, role: analyticsProcessorRole,
            vpc: mainVpc, vpcSubnets: { subnets: mainVpc.privateSubnets }, securityGroups: [processorSecurityGroup],
            environment: { ANALYTICS_BUCKET: props.analyticsBucketName, ARCHIVE_BUCKET: props.archiveBucket.bucketName, REGION: 'us-east-1' },
            logGroup: new logs.LogGroup(this, 'AnalyticsProcessorLogGroup', {
                logGroupName: '/aws/lambda/quartz-analytics-processor-beta', retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
        });

        // ---- Lambda: analytics writer ----

        const analyticsWriterRole = new iam.Role(this, 'AnalyticsWriterRole', {
            roleName: 'Quartz-Beta-AnalyticsWriter-Role',
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')],
        });
        analyticsWriterRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW, actions: ['s3:PutObject'], resources: [`${props.reportsBucket.bucketArn}/*`],
        }));
        analyticsWriterRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW, actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey'], resources: ['*'],
        }));

        new lambda.Function(this, 'AnalyticsWriter', {
            functionName: 'quartz-analytics-writer-beta',
            runtime: lambda.Runtime.PYTHON_3_11, handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/analytics-writer')),
            timeout: cdk.Duration.seconds(180), memorySize: 512, role: analyticsWriterRole,
            vpc: mainVpc, vpcSubnets: { subnets: mainVpc.publicSubnets }, allowPublicSubnet: true,
            securityGroups: [analyticsSecurityGroup],
            environment: { REPORTS_BUCKET: props.reportsBucket.bucketName, REGION: 'us-east-1' },
            logGroup: new logs.LogGroup(this, 'AnalyticsWriterLogGroup', {
                logGroupName: '/aws/lambda/quartz-analytics-writer-beta', retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
        });

        // ---- Lambda: dev processor ----

        const devProcessorRole = new iam.Role(this, 'DevProcessorRole', {
            roleName: 'Quartz-Dev-Processor-Role',
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')],
        });
        devProcessorRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW, actions: ['s3:GetObject', 's3:PutObject'], resources: [`${props.analyticsBucket.bucketArn}/*`],
        }));
        devProcessorRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW, actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey'], resources: ['*'],
        }));

        new lambda.Function(this, 'DevProcessor', {
            functionName: 'quartz-dev-processor-beta',
            runtime: lambda.Runtime.PYTHON_3_11, handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/dev-processor')),
            timeout: cdk.Duration.seconds(300), memorySize: 1024, role: devProcessorRole,
            vpc: devVpc, vpcSubnets: { subnets: devVpc.privateSubnets }, securityGroups: [devSecurityGroup],
            environment: { ANALYTICS_BUCKET: props.analyticsBucketName, REGION: 'us-east-1', ENVIRONMENT: 'dev' },
            logGroup: new logs.LogGroup(this, 'DevProcessorLogGroup', {
                logGroupName: '/aws/lambda/quartz-dev-processor-beta', retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
        });

        // ---- Lambda: config loader ----

        const configLoaderRole = new iam.Role(this, 'ConfigLoaderRole', {
            roleName: 'Quartz-Beta-ConfigLoader-Role',
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
        });
        configLoaderRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW, actions: ['s3:GetObject'], resources: [`${configBucket.bucketArn}/*`, `${tempBucket.bucketArn}/*`],
        }));
        configLoaderRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW, actions: ['kms:Decrypt'], resources: ['*'],
        }));

        new lambda.Function(this, 'ConfigLoader', {
            functionName: 'quartz-config-loader-beta',
            runtime: lambda.Runtime.PYTHON_3_11, handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/config-loader')),
            timeout: cdk.Duration.seconds(60), memorySize: 256, role: configLoaderRole,
            environment: { CONFIG_BUCKET: configBucket.bucketName, TEMP_BUCKET: tempBucket.bucketName, REGION: 'us-west-2' },
            logGroup: new logs.LogGroup(this, 'ConfigLoaderLogGroup', {
                logGroupName: '/aws/lambda/quartz-config-loader-beta', retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
        });

        // ---- Exports ----

        StackUtils.exportStack(this, 'LambdaFunctionName', reconciliationFunction.functionName, 'Reconciliation Lambda Function Name');
        StackUtils.exportStack(this, 'LambdaFunctionArn', reconciliationFunction.functionArn, 'Reconciliation Lambda Function ARN');
        StackUtils.exportStack(this, 'LambdaRoleArn', reconciliationRole.roleArn, 'Reconciliation Lambda Role ARN');
        StackUtils.exportStack(this, 'LogGroupName', reconciliationLogGroup.logGroupName, 'Reconciliation Log Group Name');
        StackUtils.exportStack(this, 'InputQueueUrl', inputQueue.queueUrl, 'Input Queue URL');
        StackUtils.exportStack(this, 'MainVpcId', mainVpc.vpcId, 'Main VPC ID');
    }
}
