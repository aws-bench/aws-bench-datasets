import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: ecs-i5l02s5g8
 *
 * 003920d3-cee1-436d-b02e-534159f1b117
 *
 * What the stack does:
 * 1. Creates an ECS Fargate cluster with Container Insights enabled
 * 2. Creates an ECS service with task definition running two containers (service + log-router)
 * 3. Creates VPC subnets across three availability zones (us-west-2a, us-west-2b, us-west-2c)
 * 4. Creates security group for ECS service tasks
 * 5. Creates ECR repository for container images
 * 6. Creates CloudWatch log groups for application logs, container stdout, and Container Insights
 * 7. Creates IAM roles for ECS service and pipeline execution
 */

export class Ecs_i5l02s5g8 extends cdk.Stack {
    private readonly accountId: string;

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        this.accountId = props.env!.account!;

        // Create VPC with dynamic naming
        const vpc = new ec2.Vpc(this, 'Vpc', {
            vpcName: `ecs-vpc-${this.account}-${this.region}`,
            maxAzs: 3,
            natGateways: 0,
            subnetConfiguration: [
                {
                    cidrMask: 19,
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                },
            ],
        });

        // Create security group for ECS service
        const ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsServiceSecurityGroup', {
            vpc,
            securityGroupName: `ecs-service-sg-${this.account}-${this.region}`,
            description: 'Security group for ECS service tasks',
            allowAllOutbound: true,
        });

        // Create ECR repository
        const ecrRepository = new ecr.Repository(this, 'EcrRepository', {
            repositoryName: `ecr-repo-${this.account}-${this.region}`,
            imageScanOnPush: false,
            encryption: ecr.RepositoryEncryption.AES_256,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            emptyOnDelete: true,
        });

        // Create ECS cluster with Container Insights
        const cluster = new ecs.Cluster(this, 'EcsCluster', {
            clusterName: `quartz-ecs-cluster-${this.account}-${this.region}`,
            vpc,
            containerInsights: true,
        });

        // Create task execution role
        const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
            roleName: `ecs-task-execution-role-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
            ],
        });

        // Grant ECR pull permissions
        ecrRepository.grantPull(taskExecutionRole);

        // Create task role
        const taskRole = new iam.Role(this, 'TaskRole', {
            roleName: `ecs-task-role-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });

        // Create task definition
        const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
            family: `quartz-ecs-task-def-${this.account}-${this.region}`,
            cpu: 2048,
            memoryLimitMiB: 4096,
            executionRole: taskExecutionRole,
            taskRole: taskRole,
            ephemeralStorageGiB: 40,
        });

        // Add log router container (Fluent Bit) - must be added before service container
        taskDefinition.addFirelensLogRouter('log-router', {
            image: ecs.ContainerImage.fromRegistry(
                `${this.accountId}.dkr.ecr.${this.region}.amazonaws.com/${ecrRepository.repositoryName}:fluent-bit-latest`,
            ),
            cpu: 256,
            memoryReservationMiB: 512,
            essential: false,
            firelensConfig: {
                type: ecs.FirelensLogRouterType.FLUENTBIT,
            },
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'log-router',
            }),
        });

        // Add service container - now using FireLens log driver
        const serviceContainer = taskDefinition.addContainer('service', {
            image: ecs.ContainerImage.fromRegistry(
                `${this.accountId}.dkr.ecr.${this.region}.amazonaws.com/${ecrRepository.repositoryName}:latest`,
            ),
            cpu: 1792,
            memoryLimitMiB: 4096,
            essential: true,
            logging: ecs.LogDrivers.firelens({}),
        });

        serviceContainer.addPortMappings({
            containerPort: 8443,
            protocol: ecs.Protocol.TCP,
        });

        // Create ECS service (without target group attachment since there's no ALB)
        const service = new ecs.FargateService(this, 'EcsService', {
            serviceName: `quartz-ecs-service-${this.account}-${this.region}`,
            cluster,
            taskDefinition,
            desiredCount: 0,
            platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
            securityGroups: [ecsSecurityGroup],
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            },
            healthCheckGracePeriod: cdk.Duration.seconds(60),
            circuitBreaker: {
                enable: true,
                rollback: true,
            },
            enableExecuteCommand: false,
            assignPublicIp: false,
        });

        // Export key resource identifiers
        StackUtils.exportStack(this, 'EcsClusterName', cluster.clusterName, 'The name of the ECS cluster');
        StackUtils.exportStack(this, 'EcsServiceName', service.serviceName, 'The name of the ECS service');
        StackUtils.exportStack(
            this,
            'TaskDefinitionArn',
            taskDefinition.taskDefinitionArn,
            'The ARN of the task definition',
        );
        StackUtils.exportStack(this, 'EcrRepositoryUri', ecrRepository.repositoryUri, 'The URI of the ECR repository');
        StackUtils.exportStack(this, 'EcrRepositoryName', ecrRepository.repositoryName, 'The name of the ECR repository');
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'The ID of the VPC');
        StackUtils.exportStack(
            this,
            'SecurityGroupId',
            ecsSecurityGroup.securityGroupId,
            'The ID of the ECS service security group',
        );
    }
}
