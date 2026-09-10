import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: ecs-a32gg1f3b
 *
 * 09fe91b3-98c7-4fec-86dd-b6dcaf890ea2
 * 
 * What the stack does:
 1. Creates an ECR repository with a container image
 2. Creates an ECS Fargate cluster with service and task definition
 3. Creates VPC with public and private subnets across two availability zones
 4. Creates security groups for ALB and Fargate service
 5. Creates Application Load Balancer with target group
 6. Creates CloudFront distribution
 7. Creates WAF web ACLs for ALB and CloudFront
 8. Creates S3 buckets for ALB and server access logs
 9. Creates Secrets Manager secret for the application
 10. Creates IAM roles for ECS task execution and task
 11. Creates CloudWatch Logs log group for Fargate container
*/

export class Ecs_a32gg1f3b extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // VPC
        const vpc = new ec2.Vpc(this, 'VPC', {
            maxAzs: 2,
            natGateways: 2,
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

        // S3 Buckets for Logging
        const serverAccessLogsBucket = new s3.Bucket(this, 'ServerAccessLogsBucket', {
            bucketName: `server-access-logs-${this.account}-${this.region}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        const albAccessLogsBucket = new s3.Bucket(this, 'ALBAccessLogsBucket', {
            bucketName: `alb-access-logs-${this.account}-${this.region}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            serverAccessLogsBucket: serverAccessLogsBucket,
            serverAccessLogsPrefix: 'alb-access-logs/',
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
                serverAccessLogsBucket.bucketArn,
                `${serverAccessLogsBucket.bucketArn}/*`,
                albAccessLogsBucket.bucketArn,
                `${albAccessLogsBucket.bucketArn}/*`,
            ],
        });

        // ECR Repository
        const ecrRepository = new ecr.Repository(this, 'ECRRepository', {
            repositoryName: `ecrrepo-${this.account}-${this.region}`,
            imageScanOnPush: false,
            imageTagMutability: ecr.TagMutability.MUTABLE,
            encryption: ecr.RepositoryEncryption.AES_256,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            emptyOnDelete: true,
        });

        // Secrets Manager Secret
        const appSecret = new secretsmanager.Secret(this, 'AppSecret', {
            secretName: `app-secret-${this.account}-${this.region}`,
            description: 'Application distribution secret',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // IAM Roles
        const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
            roleName: `ecs-task-execution-role-${this.account}-${this.region}`,
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
            roleName: `ecs-task-role-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });

        taskRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['secretsmanager:GetSecretValue'],
                resources: [appSecret.secretArn],
            }),
        );

        // CloudWatch Logs
        const logGroup = new logs.LogGroup(this, 'FargateLogGroup', {
            logGroupName: `/ecs/fargate-task-${this.account}-${this.region}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // ECS Cluster
        const cluster = new ecs.Cluster(this, 'EcsCluster', {
            clusterName: `ecs-cluster-${this.account}-${this.region}`,
            vpc: vpc,
            containerInsights: true,
        });

        // Security Groups
        const albSecurityGroup = new ec2.SecurityGroup(this, 'ALBSecurityGroup', {
            vpc: vpc,
            description: 'Security group for Application Load Balancer',
            allowAllOutbound: true,
        });

        albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP traffic from anywhere');

        albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS traffic from anywhere');

        const fargateSecurityGroup = new ec2.SecurityGroup(this, 'FargateSecurityGroup', {
            vpc: vpc,
            description: 'Security group for Fargate service',
            allowAllOutbound: true,
        });

        fargateSecurityGroup.addIngressRule(
            albSecurityGroup,
            ec2.Port.tcp(8501),
            'Allow traffic from ALB on port 8501',
        );

        // Application Load Balancer
        const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
            loadBalancerName: `alb-${this.account}-${this.region}`,
            vpc: vpc,
            internetFacing: true,
            securityGroup: albSecurityGroup,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        });

        alb.logAccessLogs(albAccessLogsBucket, 'alb-logs');

        // Target Group
        const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
            targetGroupName: `tg-${this.account}-${this.region}`,
            vpc: vpc,
            port: 8501,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                enabled: true,
                path: '/',
                protocol: elbv2.Protocol.HTTP,
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 3,
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

        // WAF Web ACL for ALB (Regional)
        const knownBadInputsRule = (metricName: string) => ({
            name: 'AWSManagedRulesKnownBadInputsRuleSet',
            priority: 0,
            overrideAction: { none: {} },
            statement: {
                managedRuleGroupStatement: {
                    vendorName: 'AWS',
                    name: 'AWSManagedRulesKnownBadInputsRuleSet',
                },
            },
            visibilityConfig: {
                sampledRequestsEnabled: true,
                cloudWatchMetricsEnabled: true,
                metricName,
            },
        });

        const albWaf = new wafv2.CfnWebACL(this, 'ALBWebACL', {
            scope: 'REGIONAL',
            defaultAction: { allow: {} },
            visibilityConfig: {
                sampledRequestsEnabled: true,
                cloudWatchMetricsEnabled: true,
                metricName: 'ALBWebACL',
            },
            rules: [knownBadInputsRule('ALBKnownBadInputs')],
        });

        // Associate WAF with ALB
        new wafv2.CfnWebACLAssociation(this, 'ALBWebACLAssociation', {
            resourceArn: alb.loadBalancerArn,
            webAclArn: albWaf.attrArn,
        });

        // WAF Web ACL for CloudFront (Global)
        const cloudFrontWaf = new wafv2.CfnWebACL(this, 'CloudFrontWebACL', {
            scope: 'CLOUDFRONT',
            defaultAction: { allow: {} },
            visibilityConfig: {
                sampledRequestsEnabled: true,
                cloudWatchMetricsEnabled: true,
                metricName: 'CloudFrontWebACL',
            },
            rules: [knownBadInputsRule('CloudFrontKnownBadInputs')],
        });

        // CloudFront Distribution
        const distribution = new cloudfront.CloudFrontWebDistribution(this, 'CloudFrontDistribution', {
            originConfigs: [
                {
                    customOriginSource: {
                        domainName: alb.loadBalancerDnsName,
                        originProtocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
                    },
                    behaviors: [{ isDefaultBehavior: true }],
                },
            ],
            webACLId: cloudFrontWaf.attrArn,
        });

        // ECS Task Definition
        const taskDefinition = new ecs.FargateTaskDefinition(this, 'FargateTaskDefinition', {
            family: `fargate-task-${this.account}-${this.region}`,
            cpu: 4096,
            memoryLimitMiB: 30720,
            taskRole: taskRole,
            executionRole: taskExecutionRole,
        });

        const containerImageTag = 'a3f1c2e4-9b7d-4e8a-b6f0-2d5c8e1a4f7b_service_main';

        const container = taskDefinition.addContainer('Container', {
            containerName: 'Container',
            image: ecs.ContainerImage.fromEcrRepository(ecrRepository, containerImageTag),
            cpu: 4096,
            memoryLimitMiB: 30720,
            essential: true,
            readonlyRootFilesystem: true,
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'FargateApp',
                logGroup: logGroup,
                mode: ecs.AwsLogDriverMode.NON_BLOCKING,
            }),
        });

        container.addPortMappings({
            containerPort: 8501,
            hostPort: 8501,
            protocol: ecs.Protocol.TCP,
        });

        // ECS Fargate Service
        const fargateService = new ecs.FargateService(this, 'FargateService', {
            serviceName: `fargate-service-${this.account}-${this.region}`,
            cluster: cluster,
            taskDefinition: taskDefinition,
            desiredCount: 0,
            assignPublicIp: false,
            securityGroups: [fargateSecurityGroup],
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            healthCheckGracePeriod: cdk.Duration.seconds(60),
            platformVersion: ecs.FargatePlatformVersion.LATEST,
        });

        fargateService.attachToApplicationTargetGroup(targetGroup);

        // Outputs
        StackUtils.exportStack(this, 'VPCId', vpc.vpcId, 'VPC ID');
        StackUtils.exportStack(this, 'ECRRepositoryUri', ecrRepository.repositoryUri, 'ECR Repository URI');
        StackUtils.exportStack(this, 'ECSClusterName', cluster.clusterName, 'ECS Cluster Name');
        StackUtils.exportStack(this, 'ALBDnsName', alb.loadBalancerDnsName, 'ALB DNS Name');
        StackUtils.exportStack(
            this,
            'CloudFrontDomainName',
            distribution.distributionDomainName,
            'CloudFront Domain Name',
        );
        StackUtils.exportStack(this, 'AppSecretArn', appSecret.secretArn, 'App Secret ARN');
        StackUtils.exportStack(this, 'FargateServiceName', fargateService.serviceName, 'Fargate Service Name');
        StackUtils.exportStack(this, 'FargateSecurityGroupId', fargateSecurityGroup.securityGroupId, 'Fargate Security Group ID');
        StackUtils.exportStack(this, 'TargetGroupArn', targetGroup.targetGroupArn, 'Target Group ARN');
        StackUtils.exportStack(this, 'TaskDefinitionFamily', taskDefinition.family, 'Task Definition Family');
        StackUtils.exportStack(this, 'PrivateSubnetId1', vpc.privateSubnets[0].subnetId, 'Private Subnet ID 1');
        StackUtils.exportStack(this, 'PrivateSubnetId2', vpc.privateSubnets[1].subnetId, 'Private Subnet ID 2');
        StackUtils.exportStack(this, 'ContainerImageTag', containerImageTag, 'Container image tag pushed by setup script');
    }
}
