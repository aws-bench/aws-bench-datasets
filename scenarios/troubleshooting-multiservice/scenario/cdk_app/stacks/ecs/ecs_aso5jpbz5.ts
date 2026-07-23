import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { Stack as DeploymentStack, StackProps as DeploymentStackProps } from 'aws-cdk-lib';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: ecs-aso5jpbz5
 *
 * 30c317ef-9ba0-4403-9533-6722c9b85a18
 *
 * What the stack does:
 * 1. VPC with 2 private subnets across 2 availability zones
 * 2. VPC endpoints for ECR (api + dkr), CloudWatch Logs, and S3 (gateway)
 * 3. Security group for ECS service
 * 4. IAM roles for ECS task and execution
 * 5. ECS cluster and Fargate service with 2 containers (service + log-router)
 * 6. CloudWatch log groups for application logs (imported by name)
 * 7. ECR repository (imported by name)
 *
 * INTENTIONAL BUG (DO NOT FIX):
 * - Task definition references container images from account 123456789012, not the deploying account
 */

export class Ecs_aso5jpbz5 extends DeploymentStack {
    constructor(scope: Construct, id: string, props: DeploymentStackProps) {
        super(scope, id, props);

        // VPC
        const vpc = new ec2.Vpc(this, 'CobaltVpc', {
            vpcName: 'cobalt-vpc',
            ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    name: 'cobalt-private-subnet',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                    cidrMask: 24,
                },
            ],
            enableDnsHostnames: true,
            enableDnsSupport: true,
        });

        cdk.Tags.of(vpc).add('Name', 'cobalt-vpc');

        // Get the private subnets
        const privateSubnets = vpc.isolatedSubnets;

        // Security group for VPC endpoints
        const endpointSecurityGroup = new ec2.SecurityGroup(this, 'EndpointSecurityGroup', {
            vpc,
            description: 'Security group for VPC endpoints',
            allowAllOutbound: false,
        });
        endpointSecurityGroup.addIngressRule(ec2.Peer.ipv4('10.0.0.0/16'), ec2.Port.tcp(443), 'HTTPS from VPC');

        // VPC endpoints required for Fargate in isolated subnets
        vpc.addInterfaceEndpoint('EcrApiEndpoint', {
            service: ec2.InterfaceVpcEndpointAwsService.ECR,
            subnets: { subnets: privateSubnets },
            securityGroups: [endpointSecurityGroup],
        });
        vpc.addInterfaceEndpoint('EcrDkrEndpoint', {
            service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
            subnets: { subnets: privateSubnets },
            securityGroups: [endpointSecurityGroup],
        });
        vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
            service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
            subnets: { subnets: privateSubnets },
            securityGroups: [endpointSecurityGroup],
        });
        vpc.addGatewayEndpoint('S3Endpoint', {
            service: ec2.GatewayVpcEndpointAwsService.S3,
            subnets: [{ subnets: privateSubnets }],
        });

        // Security Group for ECS Service
        const ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
            vpc,
            securityGroupName: 'cobalt-ecs-sg',
            description: 'Security group for Cobalt ECS service',
            allowAllOutbound: true,
        });

        ecsSecurityGroup.addIngressRule(ec2.Peer.ipv4('10.0.0.0/16'), ec2.Port.tcp(8080), 'Allow traffic from VPC');

        cdk.Tags.of(ecsSecurityGroup).add('Name', 'cobalt-ecs-sg');

        // IAM Role for ECS Task
        const taskRole = new iam.Role(this, 'EcsTaskRole', {
            roleName: 'StagingCobaltEcsServiceTaskRole',
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });

        // IAM Role for ECS Execution
        const executionRole = new iam.Role(this, 'EcsExecutionRole', {
            roleName: 'StagingCobaltEcsServiceExecutionRole',
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
            ],
        });

        // Add inline policies to execution role
        executionRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
                resources: [
                    `arn:aws:logs:${this.region}:${this.account}:log-group:CobaltService-Staging-*`,
                ],
            }),
        );

        executionRole.addToPolicy(
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

        // CloudWatch Log Groups - Import existing log groups instead of creating new ones
        const appContainerStdoutLogGroup = logs.LogGroup.fromLogGroupName(
            this,
            'AppContainerStdoutLogGroup',
            'CobaltService-Staging-AppContainer-STDOUT',
        );

        const applicationLogsLogGroup = logs.LogGroup.fromLogGroupName(
            this,
            'ApplicationLogsLogGroup',
            'CobaltService-Staging-ApplicationLogs',
        );

        const requestLogsLogGroup = logs.LogGroup.fromLogGroupName(
            this,
            'RequestLogsLogGroup',
            'CobaltService-Staging-RequestLogs',
        );

        const serviceMetricsLogGroup = logs.LogGroup.fromLogGroupName(
            this,
            'ServiceMetricsLogGroup',
            'CobaltService-Staging-ServiceMetrics',
        );

        // ECS Cluster
        const cluster = new ecs.Cluster(this, 'EcsCluster', {
            clusterName: `Staging-CobaltEcsCluster-${this.account}-${this.region}`,
            vpc,
        });

        // Task Definition
        const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
            family: 'StagingCobaltEcsServiceTaskDefinition',
            cpu: 2048,
            memoryLimitMiB: 4096,
            taskRole,
            executionRole,
        });

        // Service Container
        // intentional: image references a different account — do not replace with ${this.account}
        const serviceContainer = taskDefinition.addContainer('service', {
            image: ecs.ContainerImage.fromRegistry(
                `123456789012.dkr.ecr.us-west-2.amazonaws.com/cobaltrepo:latest_cobalt_main`,
            ),
            cpu: 1792,
            memoryLimitMiB: 4096,
            essential: true,
            logging: ecs.LogDrivers.firelens({
                options: {},
            }),
        });

        serviceContainer.addPortMappings({
            containerPort: 8080,
            protocol: ecs.Protocol.TCP,
        });

        // Log Router Container (Fluent Bit) - must be added after service container for FireLens
        // intentional: image references a different account — do not replace with ${this.account}
        taskDefinition.addFirelensLogRouter('log-router', {
            image: ecs.ContainerImage.fromRegistry(
                `123456789012.dkr.ecr.us-west-2.amazonaws.com/cobaltrepo:latest_fluent-bit_main`,
            ),
            firelensConfig: {
                type: ecs.FirelensLogRouterType.FLUENTBIT,
            },
            cpu: 256,
            memoryReservationMiB: 512,
            essential: false,
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'Application-service-firelens',
                logGroup: appContainerStdoutLogGroup,
            }),
            environment: {
                // intentional: schema specifies empty values — do not replace with CDK reference
                HOSTNAME: '',
                CLOUDWATCH_ENDPOINT: '',
            },
        });

        // ECS Service
        const service = new ecs.FargateService(this, 'EcsService', {
            serviceName: `Staging-CobaltEcsService-${this.account}-${this.region}`,
            cluster,
            taskDefinition,
            desiredCount: 0, // intentional: schema specifies 0 desired count due to failed deployment
            platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
            vpcSubnets: {
                subnets: privateSubnets,
            },
            securityGroups: [ecsSecurityGroup],
            assignPublicIp: false,
            circuitBreaker: {
                rollback: true,
            },
        });

        // Exports
        StackUtils.exportStack(this, 'AccountId', this.account, 'AWS Account ID');
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'VPC ID for Cobalt');
        StackUtils.exportStack(this, 'ClusterName', cluster.clusterName, 'ECS Cluster Name');
        StackUtils.exportStack(this, 'ServiceName', service.serviceName, 'ECS Service Name');
        StackUtils.exportStack(this, 'TaskDefinitionArn', taskDefinition.taskDefinitionArn, 'Task Definition ARN');
        StackUtils.exportStack(
            this,
            'AppContainerStdoutLogGroupName',
            appContainerStdoutLogGroup.logGroupName,
            'App Container STDOUT Log Group Name',
        );
        StackUtils.exportStack(
            this,
            'ApplicationLogsLogGroupName',
            applicationLogsLogGroup.logGroupName,
            'Application Logs Log Group Name',
        );
        StackUtils.exportStack(
            this,
            'RequestLogsLogGroupName',
            requestLogsLogGroup.logGroupName,
            'Request Logs Log Group Name',
        );
        StackUtils.exportStack(
            this,
            'ServiceMetricsLogGroupName',
            serviceMetricsLogGroup.logGroupName,
            'Service Metrics Log Group Name',
        );
    }
}
