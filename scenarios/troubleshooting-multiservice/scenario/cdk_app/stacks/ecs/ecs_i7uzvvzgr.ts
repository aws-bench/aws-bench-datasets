import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { Stack as DeploymentStack, StackProps as DeploymentStackProps } from 'aws-cdk-lib';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: ecs-i7uzvvzgr
 *
 * 32aa5269-1e30-4719-8ea5-7a46761b0f66
 *
 * What the stack does:
 * 1. Creates a VPC with isolated subnets (no NAT gateway or internet access)
 * 2. Creates an ECS Fargate cluster with two services at desiredCount: 0
 * 3. Rolling deployment service (Quartz-ecs-rolling) with ECS deployment controller
 * 4. Blue-green deployment service (Quartz-ecs-blue-green) with CODE_DEPLOY controller
 * 5. Internal ALB required by the CODE_DEPLOY controller
 *
 * Note: This is a troubleshooting scenario - configurations are intentionally preserved as-is
 */

export class Ecs_i7uzvvzgr extends DeploymentStack {
    constructor(scope: Construct, id: string, props: DeploymentStackProps) {
        super(scope, id, props);

        // Create VPC with 3 subnets across different AZs
        const vpc = new ec2.Vpc(this, 'EcsVpc', {
            maxAzs: 3,
            natGateways: 0,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'ecs-subnet',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                },
            ],
        });

        // Create security group for ECS services
        const ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsServiceSecurityGroup', {
            vpc,
            description: 'Security group for ECS services',
            securityGroupName: `ecs-service-security-group-${this.account}-${this.region}`,
            allowAllOutbound: true,
        });

        // Allow inbound HTTP traffic
        ecsSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP traffic');

        // Create security group for ALB
        const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
            vpc,
            description: 'Security group for Application Load Balancer',
            securityGroupName: `alb-security-group-${this.account}-${this.region}`,
            allowAllOutbound: true,
        });

        // Allow inbound HTTP traffic to ALB
        albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP traffic');

        // Create ECS Cluster
        const cluster = new ecs.Cluster(this, 'FargateCluster', {
            clusterName: `fargate-cluster-${this.account}-${this.region}`,
            vpc,
            enableFargateCapacityProviders: true,
        });

        // Create task execution role for both task definitions
        const taskExecutionRole = new cdk.aws_iam.Role(this, 'TaskExecutionRole', {
            assumedBy: new cdk.aws_iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
            ],
        });

        // Create task role for both task definitions
        const taskRole = new cdk.aws_iam.Role(this, 'TaskRole', {
            assumedBy: new cdk.aws_iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });

        // Task Definition for Rolling Deployment Service
        const rollingTaskDefinition = new ecs.FargateTaskDefinition(this, 'RollingTaskDefinition', {
            family: `Quartz-ecs-rolling-${this.account}-${this.region}`,
            cpu: 256,
            memoryLimitMiB: 512,
            executionRole: taskExecutionRole,
            taskRole: taskRole,
        });

        rollingTaskDefinition.addContainer('app', {
            containerName: 'app',
            image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/nginx:1.30'),
            portMappings: [
                {
                    containerPort: 80,
                    protocol: ecs.Protocol.TCP,
                },
            ],
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'rolling-service',
                logRetention: cdk.aws_logs.RetentionDays.ONE_WEEK,
            }),
        });

        // Task Definition for Blue-Green Deployment Service
        const blueGreenTaskDefinition = new ecs.FargateTaskDefinition(this, 'BlueGreenTaskDefinition', {
            family: `Quartz-ecs-blue-green-${this.account}-${this.region}`,
            cpu: 256,
            memoryLimitMiB: 512,
            executionRole: taskExecutionRole,
            taskRole: taskRole,
        });

        blueGreenTaskDefinition.addContainer('app', {
            containerName: 'app',
            image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/nginx:1.30'),
            portMappings: [
                {
                    containerPort: 80,
                    protocol: ecs.Protocol.TCP,
                },
            ],
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'blue-green-service',
                logRetention: cdk.aws_logs.RetentionDays.ONE_WEEK,
            }),
        });

        // Create Application Load Balancer
        const alb = new elbv2.ApplicationLoadBalancer(this, 'ApplicationLoadBalancer', {
            loadBalancerName: `ecs-alb-${this.account}`.substring(0, 32),
            vpc,
            internetFacing: false,
            securityGroup: albSecurityGroup,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            },
        });

        // Create Target Group for Rolling Service
        const rollingTargetGroup = new elbv2.ApplicationTargetGroup(this, 'RollingTargetGroup', {
            targetGroupName: `pipeline-ecs-rolling-tg-${this.account}`.substring(0, 32),
            vpc,
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                enabled: true,
                path: '/',
                protocol: elbv2.Protocol.HTTP,
            },
        });

        // Create Target Group for Blue-Green Service
        const blueGreenTargetGroup = new elbv2.ApplicationTargetGroup(this, 'BlueGreenTargetGroup', {
            targetGroupName: `pipeline-ecs-blue-green-tg2-${this.account}`.substring(0, 32),
            vpc,
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                enabled: true,
                path: '/',
                protocol: elbv2.Protocol.HTTP,
            },
        });

        // Add listener to ALB for rolling service
        const rollingListener = alb.addListener('RollingListener', {
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            defaultTargetGroups: [rollingTargetGroup],
        });

        // Add listener to ALB for blue-green service (on different port for testing)
        const blueGreenListener = alb.addListener('BlueGreenListener', {
            port: 8080,
            protocol: elbv2.ApplicationProtocol.HTTP,
            defaultTargetGroups: [blueGreenTargetGroup],
        });

        // Create ECS Service with Rolling Deployment (ECS deployment controller)
        const rollingService = new ecs.FargateService(this, 'RollingService', {
            serviceName: `Quartz-ecs-rolling-${this.account}-${this.region}`,
            cluster,
            taskDefinition: rollingTaskDefinition,
            desiredCount: 0,
            assignPublicIp: false,
            securityGroups: [ecsSecurityGroup],
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            },
            deploymentController: {
                type: ecs.DeploymentControllerType.ECS,
            },
            platformVersion: ecs.FargatePlatformVersion.LATEST,
            enableExecuteCommand: true,
            healthCheckGracePeriod: cdk.Duration.seconds(0),
        });

        // Attach target group to rolling service
        rollingService.attachToApplicationTargetGroup(rollingTargetGroup);

        // Configure rolling deployment parameters
        const cfnRollingService = rollingService.node.defaultChild as ecs.CfnService;
        cfnRollingService.deploymentConfiguration = {
            maximumPercent: 200,
            minimumHealthyPercent: 100,
            deploymentCircuitBreaker: {
                enable: false,
                rollback: false,
            },
        };

        // Create ECS Service with Blue-Green Deployment (CODE_DEPLOY controller)
        const blueGreenService = new ecs.FargateService(this, 'BlueGreenService', {
            serviceName: `Quartz-ecs-blue-green-${this.account}-${this.region}`,
            cluster,
            taskDefinition: blueGreenTaskDefinition,
            desiredCount: 0,
            assignPublicIp: false,
            securityGroups: [ecsSecurityGroup],
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            },
            deploymentController: {
                type: ecs.DeploymentControllerType.CODE_DEPLOY,
            },
            platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
            enableExecuteCommand: true,
            healthCheckGracePeriod: cdk.Duration.seconds(0),
        });

        // Attach target group to blue-green service
        blueGreenService.attachToApplicationTargetGroup(blueGreenTargetGroup);

        // Configure blue-green deployment parameters
        const cfnBlueGreenService = blueGreenService.node.defaultChild as ecs.CfnService;
        cfnBlueGreenService.deploymentConfiguration = {
            maximumPercent: 200,
            minimumHealthyPercent: 100,
        };

        // Export stack outputs
        StackUtils.exportStack(this, 'ClusterName', cluster.clusterName, 'ECS Cluster name');
        StackUtils.exportStack(this, 'ClusterArn', cluster.clusterArn, 'ECS Cluster ARN');
        StackUtils.exportStack(
            this,
            'RollingServiceName',
            rollingService.serviceName,
            'Rolling deployment service name',
        );
        StackUtils.exportStack(this, 'RollingServiceArn', rollingService.serviceArn, 'Rolling deployment service ARN');
        StackUtils.exportStack(
            this,
            'BlueGreenServiceName',
            blueGreenService.serviceName,
            'Blue-green deployment service name',
        );
        StackUtils.exportStack(
            this,
            'BlueGreenServiceArn',
            blueGreenService.serviceArn,
            'Blue-green deployment service ARN',
        );
        StackUtils.exportStack(
            this,
            'RollingTargetGroupArn',
            rollingTargetGroup.targetGroupArn,
            'Rolling service target group ARN',
        );
        StackUtils.exportStack(
            this,
            'BlueGreenTargetGroupArn',
            blueGreenTargetGroup.targetGroupArn,
            'Blue-green service target group ARN',
        );
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'VPC ID');
        StackUtils.exportStack(this, 'SecurityGroupId', ecsSecurityGroup.securityGroupId, 'ECS security group ID');
        StackUtils.exportStack(this, 'AlbArn', alb.loadBalancerArn, 'Application Load Balancer ARN');
        StackUtils.exportStack(this, 'AlbDnsName', alb.loadBalancerDnsName, 'Application Load Balancer DNS name');
    }
}
