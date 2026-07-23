import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * ECS Fargate with EFS Stack
 *
 * Converted from aws-cdk-examples/typescript/ecs/fargate-service-with-efs
 *
 * Creates:
 * 1. VPC (2 AZs, 1 NAT Gateway)
 * 2. ECS Fargate Cluster
 * 3. Encrypted EFS Filesystem
 * 4. Fargate Task Definition with EFS volume mount
 * 5. ApplicationLoadBalancedFargateService (internal ALB)
 */

export class EcsFargateEfs extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const vpc = new ec2.Vpc(this, 'Vpc', {
            maxAzs: 2,
            natGateways: 1,
            subnetConfiguration: [
                { cidrMask: 24, name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
                { cidrMask: 24, name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            ],
        });

        const ecsCluster = new ecs.Cluster(this, 'EcsCluster', { vpc });

        const fileSystem = new efs.FileSystem(this, 'EfsFileSystem', {
            vpc,
            encrypted: true,
            lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
            performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
            throughputMode: efs.ThroughputMode.BURSTING,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        fileSystem.addToResourcePolicy(
            new iam.PolicyStatement({
                actions: ['elasticfilesystem:ClientMount'],
                principals: [new iam.AnyPrincipal()],
                conditions: {
                    Bool: { 'elasticfilesystem:AccessedViaMountTarget': 'true' },
                },
            }),
        );

        const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
            memoryLimitMiB: 512,
            cpu: 256,
            volumes: [{
                name: 'uploads',
                efsVolumeConfiguration: { fileSystemId: fileSystem.fileSystemId },
            }],
        });

        const containerDef = new ecs.ContainerDefinition(this, 'ContainerDefinition', {
            image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx:1.29'),
            taskDefinition: taskDef,
            logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'ecs-efs' }),
        });

        containerDef.addMountPoints({
            sourceVolume: 'uploads',
            containerPath: '/uploads',
            readOnly: false,
        });

        containerDef.addPortMappings({ containerPort: 80 });

        const albFargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'Service', {
            cluster: ecsCluster,
            taskDefinition: taskDef,
            desiredCount: 2,
            publicLoadBalancer: false,
        });

        albFargateService.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '30');

        fileSystem.grantRootAccess(albFargateService.taskDefinition.taskRole.grantPrincipal);
        fileSystem.connections.allowDefaultPortFrom(albFargateService.service.connections);

        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'VPC ID');
        StackUtils.exportStack(this, 'EcsClusterName', ecsCluster.clusterName, 'ECS Cluster Name');
        StackUtils.exportStack(this, 'EcsClusterArn', ecsCluster.clusterArn, 'ECS Cluster ARN');
        StackUtils.exportStack(this, 'ServiceName', albFargateService.service.serviceName, 'ECS Fargate Service Name');
        StackUtils.exportStack(this, 'TaskDefinitionArn', taskDef.taskDefinitionArn, 'Fargate Task Definition ARN');
        StackUtils.exportStack(this, 'EfsFileSystemId', fileSystem.fileSystemId, 'EFS Filesystem ID');
        StackUtils.exportStack(this, 'AlbDnsName', albFargateService.loadBalancer.loadBalancerDnsName, 'Internal ALB DNS Name');
        StackUtils.exportStack(this, 'AlbArn', albFargateService.loadBalancer.loadBalancerArn, 'ALB ARN');
        StackUtils.exportStack(this, 'TargetGroupArn', albFargateService.targetGroup.targetGroupArn, 'Target Group ARN');
    }
}
