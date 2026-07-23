import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { AutoScalingGroup } from 'aws-cdk-lib/aws-autoscaling';
import { StackUtils } from '../lib/shared';

export interface EcsStackProps extends cdk.StackProps {
    vpc: ec2.IVpc;
    alb: elbv2.IApplicationLoadBalancer;
}

export class EcsStack extends cdk.Stack {

    constructor(scope: Construct, id: string, props: EcsStackProps) {
        super(scope, id, props);

        const { vpc, alb } = props;

        // Create ECS cluster with services
        const clusterCapacity = 2; // Downsized for auto-approve quota (2x t3.micro = 4 vCPUs)
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
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
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
            enableManagedTerminationProtection: false,
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
            image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/alpine:latest'),
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
        new elbv2.ApplicationListener(this, 'EcsListener', {
            loadBalancer: alb,
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

        // ECS Task Definition Exports
        StackUtils.exportStack(this, 'WindowsTaskDefFamily', windowsTaskDef.family);
        StackUtils.exportStack(this, 'GpuTaskDefFamily', gpuTaskDef.family);

        // ECS Service Exports
        StackUtils.exportStack(this, 'EcsServiceName', ecsService.serviceName);
        StackUtils.exportStack(this, 'EcsServiceArn', ecsService.serviceArn);

        // ALB Target Group Exports
        StackUtils.exportStack(this, 'TargetGroupArn', targetGroup.targetGroupArn);
        StackUtils.exportStack(this, 'TargetGroupName', targetGroup.targetGroupName);

        // Container Information Exports
        StackUtils.exportStack(this, 'WindowsContainerName', container.containerName);
        StackUtils.exportStack(
            this,
            'WindowsContainerWithExecutionRoleName',
            containerWithExecutionRole.containerName,
            '',
        );
        StackUtils.exportStack(this, 'GpuContainerName', gpuContainerName);
    }
}
