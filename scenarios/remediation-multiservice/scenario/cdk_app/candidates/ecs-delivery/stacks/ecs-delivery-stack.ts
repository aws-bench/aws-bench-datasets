import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { StackUtils } from '../lib/shared';
import { CONTAINER_PORT, NAMES } from './names';

export interface EcsDeliveryStackProps extends cdk.StackProps {
    readonly vpc: ec2.Vpc;
}

/**
 * Container delivery plane: the two application ECR repositories, the Fargate
 * cluster, the internal ALB in front of checkout-api and the background worker.
 */
export class EcsDeliveryStack extends cdk.Stack {
    public readonly apiRepo: ecr.Repository;
    public readonly workerRepo: ecr.Repository;
    public readonly targetGroupFullName: string;
    public readonly loadBalancerFullName: string;
    public readonly albDnsName: string;

    constructor(scope: Construct, id: string, props: EcsDeliveryStackProps) {
        super(scope, id, props);

        const vpc = props.vpc;

        // ------------------------------------------------------------------
        // ECR repositories
        // ------------------------------------------------------------------
        this.apiRepo = new ecr.Repository(this, 'CheckoutApiRepo', {
            repositoryName: NAMES.apiRepo,
            // intentional: broken by design - release tags in this repository can be
            // moved onto a different image at any time.
            imageTagMutability: ecr.TagMutability.MUTABLE,
            imageScanOnPush: true,
            emptyOnDelete: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            lifecycleRules: [
                {
                    rulePriority: 10,
                    description: 'expire untagged images after 1 day to control storage cost',
                    tagStatus: ecr.TagStatus.UNTAGGED,
                    maxImageAge: cdk.Duration.days(1),
                },
            ],
        });

        // Worker repository retention also expires *tagged* images: it keeps only the
        // two newest nightly- builds.
        this.workerRepo = new ecr.Repository(this, 'CheckoutWorkerRepo', {
            repositoryName: NAMES.workerRepo,
            imageTagMutability: ecr.TagMutability.MUTABLE,
            imageScanOnPush: true,
            emptyOnDelete: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            lifecycleRules: [
                {
                    rulePriority: 10,
                    description: 'keep only the two most recent nightly builds',
                    tagStatus: ecr.TagStatus.TAGGED,
                    tagPrefixList: ['nightly-'],
                    maxImageCount: 2,
                },
                {
                    rulePriority: 20,
                    description: 'expire untagged images after 7 days',
                    tagStatus: ecr.TagStatus.UNTAGGED,
                    maxImageAge: cdk.Duration.days(7),
                },
            ],
        });

        // The repository policy pins the deny to this role only.
        const batchRunner = new iam.Role(this, 'BatchRunnerRole', {
            roleName: NAMES.batchRunnerRole,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            description: 'Batch runner task role used by the nightly reconciliation job.',
        });
        this.apiRepo.addToResourcePolicy(new iam.PolicyStatement({
            sid: 'DenyBatchRunnerPulls',
            effect: iam.Effect.DENY,
            principals: [batchRunner],
            actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
        }));

        // ------------------------------------------------------------------
        // Cluster + log groups
        // ------------------------------------------------------------------
        const cluster = new ecs.Cluster(this, 'CheckoutCluster', {
            clusterName: NAMES.cluster,
            vpc,
            containerInsightsV2: ecs.ContainerInsights.ENABLED,
        });

        const apiLogGroup = new logs.LogGroup(this, 'ApiLogGroup', {
            logGroupName: '/ecs/checkout-api',
            retention: logs.RetentionDays.THREE_DAYS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        const workerLogGroup = new logs.LogGroup(this, 'WorkerLogGroup', {
            logGroupName: '/ecs/checkout-worker',
            retention: logs.RetentionDays.THREE_DAYS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // ------------------------------------------------------------------
        // checkout-api task definition (v2.0 - the revision currently serving)
        // ------------------------------------------------------------------
        const apiTaskDef = new ecs.FargateTaskDefinition(this, 'ApiTaskDef', {
            family: NAMES.apiFamily,
            cpu: 256,
            memoryLimitMiB: 512,
            runtimePlatform: {
                cpuArchitecture: ecs.CpuArchitecture.X86_64,
                operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
            },
        });
        apiTaskDef.addContainer(NAMES.apiContainer, {
            containerName: NAMES.apiContainer,
            image: ecs.ContainerImage.fromEcrRepository(this.apiRepo, 'v2.0'),
            essential: true,
            portMappings: [{ containerPort: CONTAINER_PORT, protocol: ecs.Protocol.TCP }],
            environment: {
                SERVICE_NAME: 'checkout-api',
                RELEASE_CHANNEL: 'stable',
            },
            logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'checkout-api', logGroup: apiLogGroup }),
            healthCheck: {
                command: ['CMD-SHELL', `wget -q -O /dev/null http://127.0.0.1:${CONTAINER_PORT}/health || exit 1`],
                interval: cdk.Duration.seconds(15),
                timeout: cdk.Duration.seconds(5),
                retries: 3,
                startPeriod: cdk.Duration.seconds(15),
            },
        });

        const workerTaskDef = new ecs.FargateTaskDefinition(this, 'WorkerTaskDef', {
            family: NAMES.workerFamily,
            cpu: 256,
            memoryLimitMiB: 512,
        });
        workerTaskDef.addContainer(NAMES.workerContainer, {
            containerName: NAMES.workerContainer,
            image: ecs.ContainerImage.fromEcrRepository(this.workerRepo, 'latest'),
            essential: true,
            entryPoint: ['sh', '-c'],
            command: ['while true; do echo "settlement batch drained"; sleep 30; done'],
            logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'checkout-worker', logGroup: workerLogGroup }),
        });

        // ------------------------------------------------------------------
        // Internal ALB
        // ------------------------------------------------------------------
        const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
            vpc,
            securityGroupName: 'checkout-alb-sg',
            description: 'Internal ALB for checkout-api - reachable from inside the VPC only',
            allowAllOutbound: true,
        });
        albSg.addIngressRule(
            ec2.Peer.ipv4(vpc.vpcCidrBlock),
            ec2.Port.tcp(80),
            'HTTP from inside the checkout VPC only',
        );

        const alb = new elbv2.ApplicationLoadBalancer(this, 'CheckoutAlb', {
            loadBalancerName: NAMES.alb,
            vpc,
            internetFacing: false,
            securityGroup: albSg,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            idleTimeout: cdk.Duration.seconds(30),
        });

        const apiTargetGroup = new elbv2.ApplicationTargetGroup(this, 'ApiTargetGroup', {
            targetGroupName: NAMES.apiTargetGroup,
            vpc,
            port: CONTAINER_PORT,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            deregistrationDelay: cdk.Duration.seconds(10),
            healthCheck: {
                path: '/health',
                healthyHttpCodes: '200',
                interval: cdk.Duration.seconds(15),
                timeout: cdk.Duration.seconds(5),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 3,
            },
        });

        alb.addListener('HttpListener', {
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            defaultTargetGroups: [apiTargetGroup],
        });

        // ------------------------------------------------------------------
        // Services
        // ------------------------------------------------------------------
        const apiSg = new ec2.SecurityGroup(this, 'ApiServiceSg', {
            vpc,
            securityGroupName: 'checkout-api-task-sg',
            description: 'checkout-api tasks - traffic from the internal ALB only',
            allowAllOutbound: true,
        });
        apiSg.addIngressRule(albSg, ec2.Port.tcp(CONTAINER_PORT), 'ALB to checkout-api');

        const apiService = new ecs.FargateService(this, 'ApiService', {
            serviceName: NAMES.apiService,
            cluster,
            taskDefinition: apiTaskDef,
            desiredCount: 0, // scaled up by the post-deploy release pipeline run
            securityGroups: [apiSg],
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            assignPublicIp: false,
            minHealthyPercent: 100,
            maxHealthyPercent: 200,
            healthCheckGracePeriod: cdk.Duration.seconds(60),
            enableExecuteCommand: false,
        });
        apiService.attachToApplicationTargetGroup(apiTargetGroup);

        const workerSg = new ec2.SecurityGroup(this, 'WorkerServiceSg', {
            vpc,
            securityGroupName: 'checkout-worker-task-sg',
            description: 'checkout-worker tasks - no inbound traffic',
            allowAllOutbound: true,
        });

        new ecs.FargateService(this, 'WorkerService', {
            serviceName: NAMES.workerService,
            cluster,
            taskDefinition: workerTaskDef,
            desiredCount: 0, // scaled up by the post-deploy nightly build run
            securityGroups: [workerSg],
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            assignPublicIp: false,
            minHealthyPercent: 0,
            maxHealthyPercent: 200,
        });

        this.targetGroupFullName = apiTargetGroup.targetGroupFullName;
        this.loadBalancerFullName = alb.loadBalancerFullName;
        this.albDnsName = alb.loadBalancerDnsName;

        // ------------------------------------------------------------------
        // Outputs (literal names only)
        // ------------------------------------------------------------------
        StackUtils.exportStack(this, 'ClusterName', NAMES.cluster, 'ECS cluster running the checkout services');
        StackUtils.exportStack(this, 'CheckoutServiceName', NAMES.apiService, 'checkout-api ECS service name');
        StackUtils.exportStack(this, 'CheckoutRepoName', NAMES.apiRepo, 'ECR repository for checkout-api images');
        StackUtils.exportStack(this, 'CheckoutTaskFamily', NAMES.apiFamily, 'checkout-api task definition family');
        StackUtils.exportStack(this, 'CheckoutTargetGroupName', NAMES.apiTargetGroup, 'ALB target group for checkout-api');
        StackUtils.exportStack(this, 'LoadBalancerName', NAMES.alb, 'Internal ALB in front of checkout-api');
        StackUtils.exportStack(this, 'WorkerServiceName', NAMES.workerService, 'checkout-worker ECS service name');
        StackUtils.exportStack(this, 'WorkerRepoName', NAMES.workerRepo, 'ECR repository for checkout-worker images');
    }
}
