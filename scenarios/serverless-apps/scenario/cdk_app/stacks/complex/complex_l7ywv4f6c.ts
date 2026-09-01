import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as msk from 'aws-cdk-lib/aws-msk';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as docdb from 'aws-cdk-lib/aws-docdb';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { aws_s3, aws_sns_subscriptions, Duration, Tags } from 'aws-cdk-lib';
import { StackUtils } from '../../lib/shared';
import { AutoScalingGroup } from 'aws-cdk-lib/aws-autoscaling';

/*
* Stack ID: complex-l7ywv4f6c

* What the stack does:
1. Replicates the state of a development sandbox account.
*/

export class Complex_l7ywv4f6c extends cdk.Stack {

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);


        // VPC for various resources with NAT Gateway monitoring
        const vpc = new ec2.Vpc(this, 'ResourcesVpc', {
            maxAzs: 2,
            natGateways: 1,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
                {
                    cidrMask: 24,
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                },
            ],
        });

        // Create ALB and S3 bucket for logs
        const albLogsBucket = new s3.Bucket(this, 'alb-access-logs-bucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            enforceSSL: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
        });

        const alb = new elbv2.ApplicationLoadBalancer(this, 'TestALB', {
            vpc,
            internetFacing: true,
        });
        alb.node.addDependency(vpc);

        // Export VPC and ALB resources
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId);
        StackUtils.exportStack(this, 'AlbArn', alb.loadBalancerArn);
        StackUtils.exportStack(this, 'AlbDnsName', alb.loadBalancerDnsName);
        StackUtils.exportStack(this, 'AlbLogsBucketName', albLogsBucket.bucketName);

        // Enable ALB logging to S3
        alb.logAccessLogs(albLogsBucket);

        // Create Launch Template
        const launchTemplate = new ec2.CfnLaunchTemplate(this, 'MyLaunchTemplate', {
            launchTemplateData: {
                instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO).toString(),
                imageId: new ec2.AmazonLinuxImage({
                    generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
                }).getImage(this).imageId,
                metadataOptions: {
                    httpTokens: 'required',
                    httpPutResponseHopLimit: 1,
                    httpEndpoint: 'enabled',
                },
            },
        });

        // Add specific instance role and permissions
        const instanceRole = new iam.Role(this, 'Ec2InstanceRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
        });

        const instanceProfile = new iam.CfnInstanceProfile(this, 'InstanceProfile', {
            roles: [instanceRole.roleName], // Attach the IAM role
        });

        // Create EC2 instance with IMDSv2 and tags using launch template
        const instance = new ec2.CfnInstance(this, 'TestInstance', {
            subnetId: vpc.publicSubnets[0].subnetId,
            iamInstanceProfile: instanceProfile.ref,
            launchTemplate: {
                launchTemplateId: launchTemplate.ref,
                version: launchTemplate.attrLatestVersionNumber,
            },
        });

        instance.node.addDependency(vpc);

        // Add tags to EC2 instance
        cdk.Tags.of(instance).add('CreatedBy', 'example-user');

        // Export EC2 resources
        StackUtils.exportStack(this, 'EC2InstanceId', instance.ref);
        StackUtils.exportStack(this, 'LaunchTemplateId', launchTemplate.ref || 'none');

        // Create RDS instance for storage space monitoring
        const allocatedStorageRDS = 20;
        const rdsInstance = new rds.DatabaseInstance(this, 'TestRDS', {
            engine: rds.DatabaseInstanceEngine.MYSQL,
            vpc,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            allocatedStorage: allocatedStorageRDS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        rdsInstance.node.addDependency(vpc);

        // Export RDS instance
        StackUtils.exportStack(this, 'RdsEndpointAllocatedStorage', allocatedStorageRDS.toString());
        StackUtils.exportStack(this, 'RdsEndpoint', rdsInstance.instanceEndpoint.hostname);
        StackUtils.exportStack(this, 'RdsInstanceId', rdsInstance.instanceIdentifier);

        // Create MSK clusters
        const eventsCluster = new msk.CfnCluster(this, 'my-events-cluster', {
            clusterName: 'my-events-cluster',
            kafkaVersion: '3.7.x',
            numberOfBrokerNodes: 2,
            brokerNodeGroupInfo: {
                instanceType: 'kafka.t3.small',
                clientSubnets: vpc.privateSubnets.map((subnet) => subnet.subnetId),
                storageInfo: {
                    ebsStorageInfo: {
                        volumeSize: 100,
                    },
                },
            },
        });

        eventsCluster.node.addDependency(vpc);

        eventsCluster.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.DELETE;
        // Ensure cleanup of MSK cluster resources
        eventsCluster.addPropertyOverride('LoggingInfo', {
            BrokerLogs: {
                CloudWatchLogs: { Enabled: false },
                Firehose: { Enabled: false },
                S3: { Enabled: false },
            },
        });

        const iotDataCluster = new msk.CfnCluster(this, 'my-iot-data-cluster', {
            clusterName: 'my-iot-data-cluster',
            kafkaVersion: '3.7.x',
            numberOfBrokerNodes: 2,
            brokerNodeGroupInfo: {
                instanceType: 'kafka.t3.small',
                clientSubnets: vpc.privateSubnets.map((subnet) => subnet.subnetId),
                storageInfo: {
                    ebsStorageInfo: {
                        volumeSize: 100,
                    },
                },
            },
        });
        iotDataCluster.node.addDependency(vpc);
        iotDataCluster.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.DELETE;
        // Ensure cleanup of MSK cluster resources
        iotDataCluster.addPropertyOverride('LoggingInfo', {
            BrokerLogs: {
                CloudWatchLogs: { Enabled: false },
                Firehose: { Enabled: false },
                S3: { Enabled: false },
            },
        });

        // Export MSK clusters
        StackUtils.exportStack(this, 'EventsClusterArn', eventsCluster.attrArn);
        StackUtils.exportStack(this, 'IotDataClusterArn', iotDataCluster.attrArn);

        // Create DynamoDB tables
        const eventLogsTable = new dynamodb.Table(this, 'my-event-logs', {
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        });

        // Export DynamoDB table
        StackUtils.exportStack(this, 'EventLogsTableName', eventLogsTable.tableName);
        StackUtils.exportStack(this, 'EventLogsTableArn', eventLogsTable.tableArn);

        const customerOrdersTable = new dynamodb.Table(this, 'my-customer-orders', {
            partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        });

        // Export Customer Orders DynamoDB table
        StackUtils.exportStack(this, 'CustomerOrdersTableName', customerOrdersTable.tableName);
        StackUtils.exportStack(this, 'CustomerOrdersTableArn', customerOrdersTable.tableArn);

        // Create S3 buckets
        const iotDataBucket = new s3.Bucket(this, 'my-iot-data-archive', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            enforceSSL: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
        });

        const orderArchivesBucket = new s3.Bucket(this, 'orders-archive-bucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            enforceSSL: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
        });

        const lifecycleBucket = new s3.Bucket(this, 'lifecycle-bucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            enforceSSL: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            lifecycleRules: [
                {
                    tagFilters: { shouldDelete: 'true' },
                    id: 'orders-archive-bucket-lifecycle-rule',
                    enabled: true,
                    expiration: Duration.days(1),
                },
            ],
        });

        // Export S3 bucket names
        StackUtils.exportStack(this, 'IotDataBucketName', iotDataBucket.bucketName);
        StackUtils.exportStack(this, 'OrderArchivesBucketName', orderArchivesBucket.bucketName);
        StackUtils.exportStack(this, 'LifeCycleBucket', lifecycleBucket.bucketName);

        // Create Lambda functions with appropriate permissions
        const eventsLambdaRole = new iam.Role(this, 'EventsLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        });

        const lambdaEventsFunctionLogGroup = new logs.LogGroup(this, 'MyLambdaEventsFunctionLogGroup', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const lambdaEventsFunction = new lambda.Function(this, 'MyLambdaEventsFunction', {
            logGroup: lambdaEventsFunctionLogGroup,
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: new lambda.InlineCode('exports.handler = async (event) => console.log(event)'),
            role: eventsLambdaRole,
        });

        lambdaEventsFunction.addEventSource(
            new lambdaEventSources.ManagedKafkaEventSource({
                clusterArn: eventsCluster.attrArn,
                topic: 'myTopic',
                batchSize: 100,
                startingPosition: lambda.StartingPosition.LATEST,
            }),
        );
        StackUtils.exportStack(this, 'MyEventsFunction', lambdaEventsFunction.functionName);

        eventsLambdaRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['kafka:*'],
                resources: [eventsCluster.attrArn],
            }),
        );
        eventsLambdaRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['dynamodb:*'],
                resources: [eventLogsTable.tableArn],
            }),
        );

        const iotDataLambdaRole = new iam.Role(this, 'IotDataLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        });

        iotDataLambdaRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['kafka:*'],
                resources: [iotDataCluster.attrArn],
            }),
        );
        iotDataLambdaRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['s3:*'],
                resources: [iotDataBucket.bucketArn, `${iotDataBucket.bucketArn}/*`],
            }),
        );

        const lambdaIotDataFunctionLogGroup = new logs.LogGroup(this, 'MyLambdaIotDataFunctionLogGroup', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const lambdaIotDataFunction = new lambda.Function(this, 'MyLambdaIotDataFunction', {
            logGroup: lambdaIotDataFunctionLogGroup,
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: new lambda.InlineCode('exports.handler = async (event) => console.log(event)'),
            role: iotDataLambdaRole,
        });
        lambdaIotDataFunction.addEventSource(
            new lambdaEventSources.ManagedKafkaEventSource({
                clusterArn: iotDataCluster.attrArn,
                topic: 'myTopic',
                batchSize: 100,
                startingPosition: lambda.StartingPosition.LATEST,
            }),
        );
        StackUtils.exportStack(this, 'MyIotDataFunction', lambdaIotDataFunction.functionName);

        // Create ECS cluster with services
        const clusterCapacity = 12; // More than 10 instances for the query
        const cluster = new ecs.Cluster(this, 'my-data-cluster', {
            vpc,
            containerInsights: true,
        });

        const asgInstanceRole = new iam.Role(this, 'ASGInstanceRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
            ],
        });

        // Use a template to launch EC2 instances within ASG
        const asgEc2LaunchTemplate = new ec2.LaunchTemplate(this, 'ASGLaunchTemplate', {
            role: asgInstanceRole,
            machineImage: ecs.EcsOptimizedImage.amazonLinux2023(),
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.LARGE),
            requireImdsv2: true,
            userData: ec2.UserData.forLinux(),
        });

        const asg = new AutoScalingGroup(this, 'DefaultAutoScalingGroup', {
            vpc: vpc,
            launchTemplate: asgEc2LaunchTemplate,
            desiredCapacity: clusterCapacity,
        });

        // Add ASG to the ECS cluster
        const capacityProvider = new ecs.AsgCapacityProvider(this, 'AsgCapacityProvider', {
            autoScalingGroup: asg,
        });
        cluster.addAsgCapacityProvider(capacityProvider);

        // Export ECS cluster
        StackUtils.exportStack(this, 'EcsClusterCapacity', clusterCapacity.toString());
        StackUtils.exportStack(this, 'EcsClusterName', cluster.clusterName);
        StackUtils.exportStack(this, 'EcsClusterArn', cluster.clusterArn);

        // Create ECS task definitions for various container types
        const windowsTaskDef = new ecs.FargateTaskDefinition(this, 'WindowsTaskDef', {
            runtimePlatform: {
                operatingSystemFamily: ecs.OperatingSystemFamily.WINDOWS_SERVER_2019_FULL,
            },
            cpu: 1024,
            memoryLimitMiB: 2048,
        });

        // Add Task Definition with custom ExecutionRole
        const executionRole = new iam.Role(this, 'TaskExecutionRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });
        executionRole.addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
        );
        const windowsTaskDefWithExecutionRole = new ecs.FargateTaskDefinition(this, 'WindowsTaskDefWithExecutionRole', {
            runtimePlatform: {
                operatingSystemFamily: ecs.OperatingSystemFamily.WINDOWS_SERVER_2019_FULL,
            },
            cpu: 1024,
            memoryLimitMiB: 2048,
            executionRole: executionRole,
        });
        const containerWithExecutionRole = windowsTaskDefWithExecutionRole.addContainer('web', {
            image: ecs.ContainerImage.fromRegistry(
                'mcr.microsoft.com/windows/servercore/iis:windowsservercore-ltsc2019',
            ),
            memoryLimitMiB: 1024,
            cpu: 512,
        });
        containerWithExecutionRole.addPortMappings({
            containerPort: 80,
        });

        const gpuTaskDef = new ecs.Ec2TaskDefinition(this, 'GpuTaskDef');
        const gpuContainerName = 'gpu-container';
        gpuTaskDef.addContainer(gpuContainerName, {
            image: ecs.ContainerImage.fromRegistry('nvidia/cuda:latest'),
            memoryLimitMiB: 4096,
            gpuCount: 1,
        });

        // Export ECS task definition ARNs
        StackUtils.exportStack(
            this,
            'WindowsTaskDefArnWithTaskExecutionRole',
            windowsTaskDefWithExecutionRole.taskDefinitionArn,
        );
        StackUtils.exportStack(this, 'WindowsTaskDefArn', windowsTaskDef.taskDefinitionArn);
        StackUtils.exportStack(this, 'GpuTaskDefArn', gpuTaskDef.taskDefinitionArn);

        // Create DocumentDB cluster
        const docDBCluster = new docdb.DatabaseCluster(this, 'my-recommendation-engine', {
            masterUser: {
                username: 'appadmin',
            },
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
            vpc,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        docDBCluster.node.addDependency(vpc);

        const docDBLambdaRole = new iam.Role(this, 'DocDBLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        });

        docDBLambdaRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['rds:*'],
                resources: [`*`],
            }),
        );
        docDBLambdaRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['dynamodb:*'],
                resources: [customerOrdersTable.tableArn],
            }),
        );

        const docDbSecret = docDBCluster.secret;
        if (docDbSecret) {
            const docDbSecretArn = docDbSecret.secretArn;
            // Grant the Lambda function permission to access the DocumentDB cluster and secret
            docDbSecret.grantRead(docDBLambdaRole);
            docDBLambdaRole.addToPolicy(
                new iam.PolicyStatement({
                    actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
                    resources: [
                        `
                arn:aws:rds:${this.region}:${this.account}:clusterIdentifier:${docDBCluster.clusterIdentifier}`,
                        docDbSecretArn,
                    ],
                }),
            );
        }

        // Create Athena workgroup and related resources
        const analysisDataBucket = new s3.Bucket(this, 'athena-analytics-data-bucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            enforceSSL: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
        });

        const featureStoreTable = new dynamodb.Table(this, 'my-feature-store', {
            partitionKey: { name: 'featureId', type: dynamodb.AttributeType.STRING },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        });

        const athenaWorkgroup = new athena.CfnWorkGroup(this, 'my-data-science-workgroup', {
            name: 'my-data-science-workgroup',
            workGroupConfiguration: {
                resultConfiguration: {
                    outputLocation: `s3://${analysisDataBucket.bucketName}/athena-results/`,
                },
            },
        });

        // Create service with load balancer
        const ecsService = new ecs.FargateService(this, 'MyService', {
            cluster,
            taskDefinition: windowsTaskDef,
            desiredCount: 2,
            assignPublicIp: true, // Add this to ensure the service can be reached
        });

        // Add container to task definition with port mapping
        const container = windowsTaskDef.addContainer('web', {
            image: ecs.ContainerImage.fromRegistry(
                'mcr.microsoft.com/windows/servercore/iis:windowsservercore-ltsc2019',
            ),
            memoryLimitMiB: 1024,
            cpu: 512,
        });
        container.addPortMappings({
            containerPort: 80,
        });

        // Add ALB target group
        const targetGroup = new elbv2.ApplicationTargetGroup(this, 'EcsTargetGroup', {
            vpc,
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targets: [ecsService],
        });
        alb.addListener('EcsListener', {
            port: 80,
            defaultTargetGroups: [targetGroup],
        });

        const repository = new ecr.Repository(this, 'MyEcrRepository', {
            repositoryName: 'my-ecr-repo',
            lifecycleRules: [
                {
                    rulePriority: 1,
                    description: 'Keep only the last 10 images',
                    maxImageCount: 10,
                },
            ],
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        StackUtils.exportStack(this, 'EcrRepositoryUri', repository.repositoryUri);

        // Create S3 bucket with analytics and public access settings
        const analyticsBucketDestination = new s3.Bucket(this, 'business-analytics-destination-data-bucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            publicReadAccess: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
        });
        const analyticsBucketName = `business-analytics-source-data-bucket-${this.account}`;
        const analyticsBucket = new aws_s3.CfnBucket(this, analyticsBucketName, {
            bucketName: analyticsBucketName,
            publicAccessBlockConfiguration: {
                blockPublicPolicy: true,
                ignorePublicAcls: true,
                restrictPublicBuckets: true,
            },
            analyticsConfigurations: [
                {
                    id: 'testAnalyticsConfiguration',
                    storageClassAnalysis: {
                        dataExport: {
                            destination: {
                                bucketArn: analyticsBucketDestination.bucketArn,
                                format: 'CSV',
                            },
                            outputSchemaVersion: 'V_1', // The version of the output schema
                        },
                    },
                },
            ],
        });

        // Create CloudWatch dashboard with ECS and Lambda metrics
        const dashboard = new cloudwatch.Dashboard(this, 'MyDashboard', {
            dashboardName: 'MyServiceMetrics',
        });

        // Add ECS metrics widget
        dashboard.addWidgets(
            new cloudwatch.GraphWidget({
                title: 'NAT Gateway Metrics',
                left: [
                    new cloudwatch.Metric({
                        namespace: 'AWS/ECS',
                        metricName: 'MemoryUtilization',
                        dimensionsMap: {
                            ClusterName: cluster.clusterName,
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
                            ClusterName: cluster.clusterName,
                        },
                    }),
                ],
            }),
        );

        // Create Lambda roles for various access patterns
        const athenaLambdaRole = new iam.Role(this, 'AthenaLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        });

        athenaLambdaRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['s3:*'],
                resources: [analysisDataBucket.bucketArn, `${analysisDataBucket.bucketArn}/*`],
            }),
        );
        athenaLambdaRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['dynamodb:*'],
                resources: [featureStoreTable.tableArn],
            }),
        );

        // Create Lambda function for data export with S3 permissions
        const exporterRole = new iam.Role(this, 'ExporterRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        });

        exporterRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['s3:GetObject'],
                resources: [`${analyticsBucket.attrArn}/*`],
            }),
        );
        exporterRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['s3:PutObject'],
                resources: [`${orderArchivesBucket.bucketArn}/*`],
            }),
        );

        // Create SNS, Lambda and SQS that are connected where SNS invokes Lambda and Lambda can write to SQS
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
        StackUtils.exportStack(this, 'ConnectedSQSURL', connectedSQS.queueUrl);

        connectedSQS.grantSendMessages(connectedLambda);
        connectedSNSTopic.addSubscription(new aws_sns_subscriptions.LambdaSubscription(connectedLambda));
        StackUtils.exportStack(this, 'ConnectedSNSTopicName', connectedSNSTopic.topicName);
        StackUtils.exportStack(this, 'ConnectedLambdaName', connectedLambda.functionName);
        StackUtils.exportStack(this, 'ConnectedLambdaRuntime', connectedLambda.runtime.toString());
        StackUtils.exportStack(this, 'ConnectedSQSName', connectedSQS.queueName);
        const sensorAlerts = new sns.Topic(this, 'my-sensor-alerts', {
            topicName: 'my-sensor-alerts',
        });

        // S3 bucket with website hosting enabled
        const websiteHostingBucket = new s3.Bucket(this, 'WebsiteHostingBucket', {
            websiteIndexDocument: 'index.html',
            publicReadAccess: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            autoDeleteObjects: true,
        });

        // S3 bucket with inventory configuration
        const inventoryBucket = new s3.Bucket(this, 'InventoryBucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            autoDeleteObjects: true,
        });
        const inventoryDestinationBucket = new s3.Bucket(this, 'InventoryDestinationBucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            autoDeleteObjects: true,
        });

        inventoryBucket.addInventory({
            destination: {
                bucket: inventoryDestinationBucket,
            },
            frequency: s3.InventoryFrequency.DAILY,
            includeObjectVersions: s3.InventoryObjectVersion.CURRENT,
            objectsPrefix: 'inventory-data',
        });

        // S3 bucket with metrics configuration
        const metricsBucket = new s3.Bucket(this, 'MetricsBucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            autoDeleteObjects: true,
        });
        metricsBucket.addMetric({
            id: 'EntireBucket',
        });
        metricsBucket.addMetric({
            id: 'ImportantPrefix',
            prefix: 'important/',
        });
        metricsBucket.addMetric({
            id: 'ImportantTag',
            tagFilters: { priority: 'high' },
        });

        // Lambda function with provisioned concurrency
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

        // Lambda layer with code on S3 (uploaded via CDK asset)
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

        // Lambda function with tags
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

        const firehoseDestinationBucket = new s3.Bucket(this, 'FirehoseDestinationBucket', {
            bucketName: `my-firehose-destination-bucket-${this.account}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            autoDeleteObjects: true,
        });

        // Create a Kinesis Firehose delivery stream
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
                roleArn: new iam.Role(this, 'FirehoseRole', {
                    assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
                }).roleArn,
            },
        });

        const metricStreamRole = new iam.Role(this, 'MetricStreamRole', {
            assumedBy: new iam.ServicePrincipal('streams.metrics.cloudwatch.amazonaws.com'),
        });

        // Add policy to allow writing to Firehose
        metricStreamRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'],
                resources: [firehoseDeliveryStream.attrArn],
            }),
        );

        const metricStream95Role = new iam.Role(this, 'MetricStream95Role', {
            assumedBy: new iam.ServicePrincipal('cloudwatch.amazonaws.com'),
        });

        // Attach permissions to the role
        metricStream95Role.addToPolicy(
            new iam.PolicyStatement({
                actions: [
                    'firehose:PutRecord',
                    'firehose:PutRecordBatch',
                    's3:PutObject',
                    's3:GetBucketAcl',
                    's3:GetBucketPolicy',
                ],
                resources: ['*'], // Adjust as necessary for your resources
            }),
        );

        // Define the metric stream
        const metricStream95 = new cloudwatch.CfnMetricStream(this, 'MetricStream95', {
            firehoseArn: firehoseDeliveryStream.attrArn,
            roleArn: metricStream95Role.roleArn,
            includeFilters: [
                {
                    namespace: 'AWS/EC2', // Example namespace
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
        StackUtils.exportStack(this, 'MetricStream95Name', metricStream95.attrArn);

        // Create metric stream with required roleArn
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
            name: 'app-metric-stream',
        });
        metricStream.node.addDependency(metricStreamRole);
        metricStream.node.addDependency(firehoseDeliveryStream);

        // Archive rule
        const logGroup = new logs.LogGroup(this, 'MyLogGroup', { removalPolicy: cdk.RemovalPolicy.DESTROY });
        const logStream = new logs.LogStream(this, 'MyLogStream', {
            logGroup,
            logStreamName: 'MyLogStream',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // DynamoDB tables
        const salesDataTable = new dynamodb.Table(this, 'SalesDataTable', {
            tableName: 'mySalesData',
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const salesHistoryTable = new dynamodb.Table(this, 'SalesHistoryTable', {
            tableName: 'mySalesHistory',
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // SNS topic and SQS queue
        const notificationsTopic = sns.Topic.fromTopicArn(
            this,
            'NotificationsTopic',
            'arn:aws:sns:us-west-2:123456789012:my-notifications',
        );

        const alertQueue = new sqs.Queue(this, 'AlertQueue', {
            queueName: 'my-alert-queue',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        StackUtils.exportStack(this, 'MyAlertQueueSQSURL', alertQueue.queueUrl);

        // Grant permissions
        // When importing a Lambda function, we need to also import its role to grant permissions
        const dataProcessorLambdaLogGroup = new logs.LogGroup(this, 'DataProcessorLambdaLogGroup', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const dataProcessorLambda = new lambda.Function(this, 'DataProcessorLambda', {
            logGroup: dataProcessorLambdaLogGroup,
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: new lambda.InlineCode('exports.handler = async (event) => console.log(event)'),
            vpc,
        });

        const processedDataBucket = s3.Bucket.fromBucketName(this, 'ProcessedDataBucket', 'processed-data-bucket');
        processedDataBucket.grantReadWrite(dataProcessorLambda);
        // Add necessary permissions and integrations
        // (Note: Some of these would typically be done when creating the resources,
        // but we're adding them here since we're working with existing resources)
        salesDataTable.grantReadWriteData(dataProcessorLambda);
        salesHistoryTable.grantReadWriteData(dataProcessorLambda);
        notificationsTopic.grantPublish(dataProcessorLambda);
        alertQueue.grantSendMessages(dataProcessorLambda);

        // Output relevant resource information
        StackUtils.exportStack(this, 'MyDataProcessorLambda', dataProcessorLambda.functionName);
        StackUtils.exportStack(this, 'MySalesDataTable', salesDataTable.tableName);
        StackUtils.exportStack(
            this,
            'WebsiteHostingBucketName',
            websiteHostingBucket.bucketName,
            'Name of the S3 bucket with website hosting enabled',
        );
        StackUtils.exportStack(
            this,
            'ConcurrentLambdaName',
            concurrentLambda.functionName,
            'Name of the Lambda function with provisioned concurrency',
        );
        StackUtils.exportStack(this, 'MetricStreamArn', metricStream.attrArn, 'Arn of the CloudWatch Metric Stream');

        // Create the S3 bucket for NLB logging
        const loggingBucket = new s3.Bucket(this, 'InternalNLBLoggingBucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
        });
        const internalNLB = new elbv2.NetworkLoadBalancer(this, 'InternalNLB', {
            vpc,
            internetFacing: false,
            loadBalancerName: 'InternalNLB',
            vpcSubnets: {
                subnets: vpc.privateSubnets,
            },
        });
        internalNLB.logAccessLogs(loggingBucket);

        StackUtils.exportStack(this, 'InternalNLBName', internalNLB.loadBalancerFullName);
        StackUtils.exportStack(this, 'InternalNLBAccessLoggingBucketName', loggingBucket.bucketName);


        StackUtils.exportStack(this, 'DocDbClusterName', docDBCluster.clusterIdentifier);
        StackUtils.exportStack(this, 'DocDbClusterEndpoint', docDBCluster.clusterEndpoint.hostname);
        StackUtils.exportStack(
            this,
            'DocDbClusterArn',
            `arn:aws:rds:${this.region}:${this.account}:clusterIdentifier:${docDBCluster.clusterIdentifier}`,
            '',
        );
        StackUtils.exportStack(
            this,
            'DocDbSecurityGroupId',
            docDBCluster.connections.securityGroups[0].securityGroupId,
            '',
        );

        // Athena Resources Exports
        StackUtils.exportStack(this, 'AnalysisDataBucketName', analysisDataBucket.bucketName);
        StackUtils.exportStack(this, 'AnalysisDataBucketArn', analysisDataBucket.bucketArn);
        StackUtils.exportStack(this, 'AthenaWorkgroupName', athenaWorkgroup.name);
        StackUtils.exportStack(
            this,
            'AthenaOutputLocation',
            `s3://${analysisDataBucket.bucketName}/athena-results/`,
            '',
        );

        // ECS Task Definition Exports
        StackUtils.exportStack(this, 'WindowsTaskDefFamily', windowsTaskDef.family);
        StackUtils.exportStack(this, 'GpuTaskDefFamily', gpuTaskDef.family);

        // ECS Service Exports
        StackUtils.exportStack(this, 'EcsServiceName', ecsService.serviceName);
        StackUtils.exportStack(this, 'EcsServiceArn', ecsService.serviceArn);

        // ALB Target Group Exports
        StackUtils.exportStack(this, 'TargetGroupArn', targetGroup.targetGroupArn);
        StackUtils.exportStack(this, 'TargetGroupName', targetGroup.targetGroupName);

        // Analytics Bucket Exports
        StackUtils.exportStack(this, 'AnalyticsBucketName', analyticsBucketName);

        // Inventory Bucket Exports
        StackUtils.exportStack(this, 'InventoryBucketName', inventoryBucket.bucketName);

        // CloudWatch Dashboard Exports
        StackUtils.exportStack(this, 'DashboardName', dashboard.dashboardName);
        StackUtils.exportStack(this, 'DashboardArn', dashboard.dashboardArn);

        //
        StackUtils.exportStack(this, 'LogStream', logStream.logStreamName);
        StackUtils.exportStack(this, 'LogGroup', logGroup.logGroupName);
        // IAM Role Exports
        StackUtils.exportStack(this, 'AthenaLambdaRoleName', athenaLambdaRole.roleName);
        StackUtils.exportStack(this, 'AthenaLambdaRoleArn', athenaLambdaRole.roleArn);
        StackUtils.exportStack(this, 'DocDBLambdaRoleName', docDBLambdaRole.roleArn);
        StackUtils.exportStack(this, 'DocDBLambdaRoleArn', docDBLambdaRole.roleName);
        StackUtils.exportStack(this, 'ExporterRoleName', exporterRole.roleName);
        StackUtils.exportStack(this, 'ExporterRoleArn', exporterRole.roleArn);

        // SNS Topic Exports
        StackUtils.exportStack(this, 'SensorAlertsTopicName', sensorAlerts.topicName);
        StackUtils.exportStack(this, 'SensorAlertsTopicArn', sensorAlerts.topicArn);

        // Container Information Exports
        StackUtils.exportStack(this, 'WindowsContainerName', container.containerName);
        StackUtils.exportStack(
            this,
            'WindowsContainerWithExecutionRoleName',
            containerWithExecutionRole.containerName,
            '',
        );
        StackUtils.exportStack(this, 'GpuContainerName', gpuContainerName);
        StackUtils.exportStack(
            this,
            'FirehoseDeliveryStreamName',
            firehoseDeliveryStream.deliveryStreamName || firehoseDeliveryStreamName,
            'Name of the Kinesis Firehose Delivery Stream',
        );
        StackUtils.exportStack(
            this,
            'MetricStreamName',
            metricStream.name || metricStreamName,
            'Name of the CloudWatch Metric Stream',
        );
        StackUtils.exportStack(
            this,
            'FirehoseDestinationBucketName',
            firehoseDestinationBucket.bucketName,
            'Name of the S3 bucket for Kinesis Firehose destination',
        );
        StackUtils.exportStack(this, 'MetricsBucketName', metricsBucket.bucketName);
    }
}
