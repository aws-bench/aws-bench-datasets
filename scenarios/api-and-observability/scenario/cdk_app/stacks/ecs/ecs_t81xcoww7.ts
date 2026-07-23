import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';
import * as path from 'path';

/*
 * Stack ID: ecs-t81xcoww7
 *
 * 9cee7991-14b2-46bd-950d-c132a8710f55
 *
 * What the stack does:
 * 1. Creates S3 buckets for ALB logs and Athena query results
 * 2. Creates a Glue database and table for querying ALB logs via Athena
 * 3. Creates VPC with public and private subnets
 * 4. Creates an Application Load Balancer with target group
 * 5. Creates an ECS Fargate cluster with service and task definition
 * 6. Creates CloudWatch log groups for ECS and Lambda
 * 7. Creates a Lambda function
 * 8. Creates an SSM parameter to control the client endpoint path
 * 9. Creates a client ECS service that sends traffic to the ALB
 */

export class Ecs_t81xcoww7 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // S3 bucket for ALB access logs
        const albLogsBucket = new s3.Bucket(this, 'ALBLogsBucket', {
            bucketName: `tigris-logs-${this.account}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            versioned: false,
            lifecycleRules: [
                {
                    id: 'ExpireOldLogs',
                    enabled: true,
                    expiration: cdk.Duration.days(90),
                },
            ],
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        // S3 bucket for Athena query results
        const athenaResultsBucket = new s3.Bucket(this, 'AthenaResultsBucket', {
            bucketName: `aws-athena-query-results-${this.account}-${this.region}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            versioned: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
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
                albLogsBucket.bucketArn,
                `${albLogsBucket.bucketArn}/*`,
                athenaResultsBucket.bucketArn,
                `${athenaResultsBucket.bucketArn}/*`,
            ],
        });

        // Glue database for ALB logs
        const glueDatabase = new glue.CfnDatabase(this, 'GlueDatabase', {
            catalogId: this.account,
            databaseInput: {
                name: 'default',
            },
        });

        // Glue table for ALB logs (used by Athena)
        // ALB logs are written to: s3://bucket/AWSLogs/account/elasticloadbalancing/region/
        const albLogTable = new glue.CfnTable(this, 'ALBLogTable', {
            catalogId: this.account,
            databaseName: 'default',
            tableInput: {
                name: 'alb_log',
                tableType: 'EXTERNAL_TABLE',
                parameters: {
                    'classification': 'text',
                },
                storageDescriptor: {
                    location: `s3://${albLogsBucket.bucketName}/AWSLogs/${this.account}/elasticloadbalancing/${this.region}/`,
                    inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
                    outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
                    serdeInfo: {
                        serializationLibrary: 'org.apache.hadoop.hive.serde2.RegexSerDe',
                        parameters: {
                            'serialization.format': '1',
                            'input.regex': '([^ ]*) ([^ ]*) ([^ ]*) ([^ ]*):([0-9]*) ([^ ]*)[:-]([0-9]*) ([-.0-9]*) ([-.0-9]*) ([-.0-9]*) (|[-0-9]*) (-|[-0-9]*) ([-0-9]*) ([-0-9]*) "([^ ]*) ([^ ]*) (- |[^ ]*)" "([^"]*)" ([A-Z0-9-]+) ([A-Za-z0-9.-]*) ([^ ]*) "([^"]*)" "([^"]*)" "([^"]*)" ([-.0-9]*) ([^ ]*) "([^"]*)" "([^"]*)" "([^ ]*)" "([^\\s]+?)" "([^\\s]+)" "([^ ]*)" "([^ ]*)"',
                        },
                    },
                    columns: [
                        { name: 'type', type: 'string' },
                        { name: 'time', type: 'string' },
                        { name: 'elb', type: 'string' },
                        { name: 'client_ip', type: 'string' },
                        { name: 'client_port', type: 'int' },
                        { name: 'target_ip', type: 'string' },
                        { name: 'target_port', type: 'int' },
                        { name: 'request_processing_time', type: 'double' },
                        { name: 'target_processing_time', type: 'double' },
                        { name: 'response_processing_time', type: 'double' },
                        { name: 'elb_status_code', type: 'string' },
                        { name: 'target_status_code', type: 'string' },
                        { name: 'received_bytes', type: 'bigint' },
                        { name: 'sent_bytes', type: 'bigint' },
                        { name: 'request_verb', type: 'string' },
                        { name: 'request_url', type: 'string' },
                        { name: 'request_proto', type: 'string' },
                        { name: 'user_agent', type: 'string' },
                        { name: 'ssl_cipher', type: 'string' },
                        { name: 'ssl_protocol', type: 'string' },
                        { name: 'target_group_arn', type: 'string' },
                        { name: 'trace_id', type: 'string' },
                        { name: 'domain_name', type: 'string' },
                        { name: 'chosen_cert_arn', type: 'string' },
                        { name: 'matched_rule_priority', type: 'string' },
                        { name: 'request_creation_time', type: 'string' },
                        { name: 'actions_executed', type: 'string' },
                        { name: 'redirect_url', type: 'string' },
                        { name: 'lambda_error_reason', type: 'string' },
                        { name: 'target_port_list', type: 'string' },
                        { name: 'target_status_code_list', type: 'string' },
                        { name: 'classification', type: 'string' },
                        { name: 'classification_reason', type: 'string' },
                    ],
                },
            },
        });

        // Ensure table is created after database
        albLogTable.addDependency(glueDatabase);

        // VPC for ECS and ALB
        const vpc = new ec2.Vpc(this, 'VPC', {
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

        // Security group for ALB
        const albSecurityGroup = new ec2.SecurityGroup(this, 'ALBSecurityGroup', {
            vpc: vpc,
            description: 'Security group for Application Load Balancer',
            allowAllOutbound: true,
        });

        albSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(443),
            'Allow HTTPS traffic from anywhere',
        );

        albSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(80),
            'Allow HTTP traffic from anywhere',
        );

        // Security group for ECS tasks
        const ecsSecurityGroup = new ec2.SecurityGroup(this, 'ECSSecurityGroup', {
            vpc: vpc,
            description: 'Security group for ECS Fargate tasks',
            allowAllOutbound: true,
        });

        ecsSecurityGroup.addIngressRule(
            albSecurityGroup,
            ec2.Port.tcp(8080),
            'Allow traffic from ALB on port 8080',
        );

        // Application Load Balancer
        const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
            loadBalancerName: `tigris-service-alb-${this.account}`,
            vpc: vpc,
            internetFacing: true,
            securityGroup: albSecurityGroup,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        });

        alb.logAccessLogs(albLogsBucket);

        // Target group for ECS service
        const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
            targetGroupName: `tigris-service-tg-${this.account}`,
            vpc: vpc,
            port: 8080,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                enabled: true,
                path: '/health',
                protocol: elbv2.Protocol.HTTP,
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 2,
                timeout: cdk.Duration.seconds(5),
                interval: cdk.Duration.seconds(30),
            },
            deregistrationDelay: cdk.Duration.seconds(30),
        });

        // ALB Listener
        alb.addListener('HTTPListener', {
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            defaultTargetGroups: [targetGroup],
        });

        // CloudWatch Log Groups
        const ecsLogGroup = new logs.LogGroup(this, 'ECSLogGroup', {
            logGroupName: '/ecs/DanubeTigris',
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const lambdaLogGroup = new logs.LogGroup(this, 'LambdaLogGroup', {
            logGroupName: '/aws/lambda/tigris-danube-lambda-entrypoint',
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // ECS Cluster
        const cluster = new ecs.Cluster(this, 'ECSCluster', {
            clusterName: `tigris-ecs-cluster-${this.account}`,
            vpc: vpc,
            containerInsights: true,
            enableFargateCapacityProviders: true,
        });

        // IAM Roles for ECS
        const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
            roleName: `tigris-task-execution-role-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
            ],
        });

        taskExecutionRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    'ecr:GetAuthorizationToken',
                    'ecr:BatchCheckLayerAvailability',
                    'ecr:GetDownloadUrlForLayer',
                    'ecr:BatchGetImage',
                ],
                resources: ['*'],
            }),
        );

        const taskRole = new iam.Role(this, 'TaskRole', {
            roleName: `tigris-task-role-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });

        // ECS Task Definition
        const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
            family: `tigris-api-task-${this.account}`,
            cpu: 256,
            memoryLimitMiB: 512,
            taskRole: taskRole,
            executionRole: taskExecutionRole,
        });

        const container = taskDefinition.addContainer('Container', {
            containerName: 'tigris-api-container',
            image: ecs.ContainerImage.fromAsset(path.join(__dirname, '../../assets/tigris-api')),
            cpu: 256,
            memoryLimitMiB: 512,
            essential: true,
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'tigris-api',
                logGroup: ecsLogGroup,
                mode: ecs.AwsLogDriverMode.NON_BLOCKING,
            }),
            environment: {
                SERVICE_NAME: 'TigrisBeatsService',
            },
        });

        container.addPortMappings({
            containerPort: 8080,
            hostPort: 8080,
            protocol: ecs.Protocol.TCP,
        });

        // ECS Fargate Service
        const fargateService = new ecs.FargateService(this, 'FargateService', {
            serviceName: `tigris-api-service-${this.account}`,
            cluster: cluster,
            taskDefinition: taskDefinition,
            desiredCount: 1,
            assignPublicIp: false,
            securityGroups: [ecsSecurityGroup],
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            healthCheckGracePeriod: cdk.Duration.seconds(60),
            platformVersion: ecs.FargatePlatformVersion.LATEST,
        });

        fargateService.attachToApplicationTargetGroup(targetGroup);

        // SSM parameter for client service configuration
        const endpointPathParam = new ssm.StringParameter(this, 'EndpointPathParam', {
            parameterName: '/tigris/prod/service-config',
            stringValue: '/jobInstance/updateStatus',
        });

        // Client task role
        const clientTaskRole = new iam.Role(this, 'ClientTaskRole', {
            roleName: `tigris-client-role-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });

        clientTaskRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['ssm:GetParameter'],
                resources: [endpointPathParam.parameterArn],
            }),
        );

        // Client task definition
        const clientTaskDefinition = new ecs.FargateTaskDefinition(this, 'ClientTaskDefinition', {
            family: `tigris-client-task-${this.account}`,
            cpu: 256,
            memoryLimitMiB: 512,
            taskRole: clientTaskRole,
            executionRole: taskExecutionRole,
        });

        // Client log group
        const clientLogGroup = new logs.LogGroup(this, 'ClientLogGroup', {
            logGroupName: `tigris-client-logs-${this.account}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        clientTaskDefinition.addContainer('TigrisClient', {
            containerName: 'tigris-client',
            image: ecs.ContainerImage.fromAsset(path.join(__dirname, '../../assets/tigris-client')),
            cpu: 256,
            memoryLimitMiB: 512,
            essential: true,
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'tigris-client',
                logGroup: clientLogGroup,
            }),
            environment: {
                AWS_REGION: this.region,
                ALB_DNS_NAME: alb.loadBalancerDnsName,
                ENDPOINT_PATH_PARAM: endpointPathParam.parameterName,
            },
        });

        // Client ECS service — runs in private subnet, talks to ALB via internal DNS
        const clientService = new ecs.FargateService(this, 'ClientService', {
            serviceName: `tigris-client-service-${this.account}`,
            cluster: cluster,
            taskDefinition: clientTaskDefinition,
            desiredCount: 1,
            assignPublicIp: false,
            securityGroups: [ecsSecurityGroup],
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            platformVersion: ecs.FargatePlatformVersion.LATEST,
        });

        // Lambda function
        const lambdaRole = new iam.Role(this, 'LambdaRole', {
            roleName: `danube-lambda-role-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
            ],
        });

        const lambdaFunction = new lambda.Function(this, 'LambdaFunction', {
            functionName: `tigris-danube-lambda-entrypoint-${this.account}`,
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'index.handler',
            code: lambda.Code.fromInline('exports.handler = async () => ({ statusCode: 200 });'),
            memorySize: 128,
            timeout: cdk.Duration.seconds(30),
            role: lambdaRole,
            logGroup: lambdaLogGroup,
            environment: {
                SERVICE_NAME: 'TigrisBeatsService',
            },
        });

        // Outputs
        StackUtils.exportStack(this, 'ALBLogsBucketName', albLogsBucket.bucketName, 'S3 bucket for ALB logs');
        StackUtils.exportStack(this, 'AthenaResultsBucketName', athenaResultsBucket.bucketName, 'S3 bucket for Athena results');
        StackUtils.exportStack(this, 'ALBDnsName', alb.loadBalancerDnsName, 'ALB DNS Name');
        StackUtils.exportStack(this, 'ALBArn', alb.loadBalancerArn, 'ALB ARN');
        StackUtils.exportStack(this, 'TargetGroupArn', targetGroup.targetGroupArn, 'Target Group ARN');
        StackUtils.exportStack(this, 'ECSClusterName', cluster.clusterName, 'ECS Cluster Name');
        StackUtils.exportStack(this, 'ECSServiceName', fargateService.serviceName, 'ECS Service Name');
        StackUtils.exportStack(this, 'ECSLogGroupName', ecsLogGroup.logGroupName, 'ECS Log Group Name');
        StackUtils.exportStack(this, 'LambdaFunctionName', lambdaFunction.functionName, 'Lambda Function Name');
        StackUtils.exportStack(this, 'LambdaLogGroupName', lambdaLogGroup.logGroupName, 'Lambda Log Group Name');
        StackUtils.exportStack(this, 'GlueTableName', albLogTable.ref, 'Glue Table Name');
        StackUtils.exportStack(this, 'GlueDatabaseName', glueDatabase.ref, 'Glue Database Name');
        StackUtils.exportStack(this, 'EndpointPathParamName', endpointPathParam.parameterName, 'SSM parameter for client endpoint path');
        StackUtils.exportStack(this, 'ClientServiceName', clientService.serviceName, 'Client ECS Service Name');
    }
}
