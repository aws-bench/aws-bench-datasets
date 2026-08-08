import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';
import { Stack as DeploymentStack, StackProps as DeploymentStackProps } from 'aws-cdk-lib';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: ecs-t3oo10okn
 *
 * What the stack does:
 * 1. Creates ECS infrastructure for BasaltInference application
 * 2. Sets up two ECS clusters (default and BasaltInference-cluster)
 * 3. Creates task definition with GPU support and FluentBit logging
 * 4. Creates CloudWatch log group for ECS logs
 * 5. Creates IAM roles for task execution and task role
 * 6. Imports existing ECR repository for container images
 * 7. Creates VPC with public and private subnets
 * 8. Creates ECS service
 */

export class Ecs_t3oo10okn extends DeploymentStack {
    constructor(scope: Construct, id: string, props: DeploymentStackProps) {
        super(scope, id, props);

        // Create VPC for ECS resources
        const vpc = new ec2.Vpc(this, 'EcsVpc', {
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

        // Create CloudWatch Log Group
        const logGroup = new logs.LogGroup(this, 'EcsLogGroup', {
            logGroupName: '/ecs/BasaltInference',
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Import existing ECR Repository (already exists in the account)
        const ecrRepository = ecr.Repository.fromRepositoryName(
            this,
            'EcrRepository',
            `basaltrepo-${this.account}-${this.region}`,
        );

        // Create IAM Task Execution Role
        const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
            roleName: `BasaltInference-TaskExecution-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
            ],
        });

        // Grant ECR permissions to execution role
        ecrRepository.grantPull(taskExecutionRole);

        // Grant CloudWatch Logs permissions
        logGroup.grantWrite(taskExecutionRole);

        // Create IAM Task Role
        const taskRole = new iam.Role(this, 'TaskRole', {
            roleName: `BasaltInference-Task-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });

        // Grant CloudWatch metrics permissions to task role
        taskRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['cloudwatch:PutMetricData'],
                resources: ['*'],
            }),
        );

        // Create default ECS Cluster
        const defaultCluster = new ecs.Cluster(this, 'DefaultCluster', {
            clusterName: `default-${this.account}-${this.region}`,
            vpc: vpc,
        });

        // Create BasaltInference ECS Cluster
        const appCluster = new ecs.Cluster(this, 'AppCluster', {
            clusterName: `BasaltInference-cluster-${this.account}-${this.region}`,
            vpc: vpc,
        });

        // Create instance role for ECS container instances
        const instanceRole = new iam.Role(this, 'InstanceRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
            ],
        });

        // Create launch template (Launch Configurations are not supported in this account)
        const userData = ec2.UserData.forLinux();
        userData.addCommands(
            `echo ECS_CLUSTER=${appCluster.clusterName} >> /etc/ecs/ecs.config`,
            'mkdir -p /opt/models/basalt-tensorrt-fp8',
            'chown -R 1000:1000 /opt/models',
        );
        const launchTemplate = new ec2.LaunchTemplate(this, 'GpuLaunchTemplate', {
            instanceType: new ec2.InstanceType('g4dn.2xlarge'),
            machineImage: ecs.EcsOptimizedImage.amazonLinux2023(ecs.AmiHardwareType.GPU),
            role: instanceRole,
            requireImdsv2: true,
            userData,
        });

        // Add EC2 capacity with GPU support to app cluster via ASG with launch template
        const autoScalingGroup = new autoscaling.AutoScalingGroup(this, 'GpuCapacity', {
            vpc,
            launchTemplate,
            desiredCapacity: 0,
            minCapacity: 0,
            maxCapacity: 1,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        });
        const capacityProvider = new ecs.AsgCapacityProvider(this, 'GpuCapacityProvider', {
            autoScalingGroup,
            enableManagedTerminationProtection: false,
        });
        appCluster.addAsgCapacityProvider(capacityProvider);

        // Create EC2 Task Definition
        const taskDefinition = new ecs.Ec2TaskDefinition(this, 'TaskDefinition', {
            family: `BasaltInferenceDevModelServiceBasaltInferenceTaskDefinition-${this.account}`,
            networkMode: ecs.NetworkMode.AWS_VPC,
            taskRole: taskRole,
            executionRole: taskExecutionRole,
        });

        // Add host volume for models
        taskDefinition.addVolume({
            name: 'models-volume',
            host: {
                sourcePath: '/opt/models',
            },
        });

        // Add FluentBit log router using addFirelensLogRouter
        taskDefinition.addFirelensLogRouter('FluentBitContainer', {
            image: ecs.ContainerImage.fromEcrRepository(
                ecrRepository,
                'dev_build_sidecar_latest',
            ),
            cpu: 512,
            memoryReservationMiB: 512,
            essential: true,
            environment: {
                MODEL_ID: 'Flint',
                LOG_REGION: 'us-east-1',
                MODEL_GROUP: 'BasaltInference',
            },
            logging: new ecs.AwsLogDriver({
                logGroup: logGroup,
                streamPrefix: 'FluentBit-',
            }),
            healthCheck: {
                command: ['CMD-SHELL', 'pgrep -f fluent-bit || exit 1'],
                interval: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(5),
                retries: 3,
                startPeriod: cdk.Duration.seconds(30),
            },
            firelensConfig: {
                type: ecs.FirelensLogRouterType.FLUENTBIT,
                options: {
                    configFileType: ecs.FirelensConfigFileType.FILE,
                    configFileValue: '/config/fluent-bit.conf',
                    enableECSLogMetadata: false,
                },
            },
        });

        // Create FireLens log driver for app container
        const fluentBitLogDriver = new ecs.FireLensLogDriver({
            options: {},
        });

        // Add main application container
        const appContainer = taskDefinition.addContainer('Container', {
            image: ecs.ContainerImage.fromEcrRepository(
                ecrRepository,
                'dev_build_service_latest',
            ),
            cpu: 2048,
            memoryReservationMiB: 16000,
            essential: true,
            environment: {
                METRICS_NAMESPACE: 'BasaltInference/BasaltInference',
                MODEL_ID: 'Flint',
                AWS_REGION: 'us-east-1',
                STAGE: 'dev',
                ENVIRONMENT: 'dev',
                MODEL_PATH: '/mnt/models/basalt-tensorrt-fp8',
                LOG_LEVEL: 'INFO',
            },
            logging: fluentBitLogDriver,
            portMappings: [
                {
                    containerPort: 8080,
                    hostPort: 8080,
                    protocol: ecs.Protocol.TCP,
                },
            ],
            gpuCount: 1,
        });

        // Add volume mount to app container
        appContainer.addMountPoints({
            sourceVolume: 'models-volume',
            containerPath: '/mnt/models',
            readOnly: false,
        });

        // Create ECS Service
        const service = new ecs.Ec2Service(this, 'EcsService', {
            cluster: appCluster,
            taskDefinition: taskDefinition,
            serviceName: `BasaltInference-${this.account}-${this.region}`,
            desiredCount: 0,
            minHealthyPercent: 0,
            maxHealthyPercent: 100,
        });

        // Export stack outputs
        StackUtils.exportStack(this, 'DefaultClusterName', defaultCluster.clusterName, 'Default ECS cluster name');
        StackUtils.exportStack(this, 'AppClusterName', appCluster.clusterName, 'Application ECS cluster name');
        StackUtils.exportStack(this, 'TaskDefinitionArn', taskDefinition.taskDefinitionArn, 'Task definition ARN');
        StackUtils.exportStack(this, 'ServiceName', service.serviceName, 'ECS service name');
        StackUtils.exportStack(this, 'LogGroupName', logGroup.logGroupName, 'CloudWatch log group name');
        StackUtils.exportStack(this, 'EcrRepositoryUri', ecrRepository.repositoryUri, 'ECR repository URI');
        StackUtils.exportStack(this, 'TaskRoleArn', taskRole.roleArn, 'Task role ARN');
        StackUtils.exportStack(this, 'ExecutionRoleArn', taskExecutionRole.roleArn, 'Execution role ARN');
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'VPC ID');
    }
}
