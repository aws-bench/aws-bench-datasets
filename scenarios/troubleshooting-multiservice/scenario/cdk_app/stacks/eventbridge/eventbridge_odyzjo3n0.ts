import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: eventbridge-odyzjo3n0
 * 
 * 0d63ce78-86de-4f67-8b32-cf39e1a2c8e0
 *  
 * What the stack does:
 * This is a troubleshooting environment that replicates an EventBridge-triggered ECS task setup.
 * The stack creates:
 * 1. EventBridge rule that triggers monthly on a cron schedule
 * 2. ECS cluster
 * 3. ECS task definition for scheduled tests with Fargate
 * 4. IAM roles for EventBridge and ECS task execution
 * 5. S3 bucket for deployment artifacts
 * 6. VPC with subnets and security groups
 */

export class Eventbridge_odyzjo3n0 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // S3 Bucket for deployment artifacts
            const deploymentBucket = new s3.Bucket(this, 'DeploymentBucket', {
                bucketName: `deploymentbucket-${this.account}-${this.region}`,
                encryption: s3.BucketEncryption.S3_MANAGED,
                enforceSSL: true,
                versioned: false,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
                autoDeleteObjects: true,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
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
                    deploymentBucket.bucketArn,
                    `${deploymentBucket.bucketArn}/*`,
                ],
            });

            // CloudWatch Log Group for scheduled task (us-east-1)
            const quartzTaskLogGroup = new logs.LogGroup(this, 'QuartzTaskLogGroup', {
                logGroupName: `QuartzService-Alpha-ScheduledTaskLogGroup-${this.account}-${this.region}`,
                logGroupClass: logs.LogGroupClass.STANDARD,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            });

            // VPC - Use default VPC
            const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', {
                isDefault: true,
            });

            // Security Group - Create a new one for the ECS tasks
            const securityGroup = new ec2.SecurityGroup(this, 'TaskSecurityGroup', {
                vpc: vpc,
                description: 'Security group for ECS Fargate tasks',
                allowAllOutbound: true,
            });

            // IAM Role for scheduled task execution (task and execution role)
            const scheduledTaskRunRole = new iam.Role(this, 'ScheduledTaskRunRole', {
                roleName: `ScheduledTaskRunRole-${this.account}-${this.region}`,
                description: 'IAM role for scheduled task execution',
                assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
                managedPolicies: [
                    iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
                ],
            });

            // Grant permissions to read from S3 bucket
            deploymentBucket.grantRead(scheduledTaskRunRole);

            // Grant permissions to write to CloudWatch Logs
            quartzTaskLogGroup.grantWrite(scheduledTaskRunRole);

            // IAM Role for EventBridge
            const eventBridgeRole = new iam.Role(this, 'EventBridgeRole', {
                roleName: `QuartzService-EventBridgeRole-${this.account}-${this.region}`,
                assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
                maxSessionDuration: cdk.Duration.hours(1),
            });

            // Add inline policy to EventBridge role
            eventBridgeRole.addToPolicy(
                new iam.PolicyStatement({
                    actions: ['ecs:RunTask'],
                    resources: ['*'],
                }),
            );

            eventBridgeRole.addToPolicy(
                new iam.PolicyStatement({
                    actions: ['iam:PassRole'],
                    resources: [scheduledTaskRunRole.roleArn],
                }),
            );

            // ECS Cluster
            const cluster = new ecs.Cluster(this, 'ScheduledTaskCluster', {
                clusterName: `QuartzService_Default-${this.account}-${this.region}`,
                vpc: vpc,
                enableFargateCapacityProviders: true,
            });

            // ECS Task Definition
            const taskDefinition = new ecs.FargateTaskDefinition(this, 'QuartzTaskDefinition', {
                family: `QuartzServiceAlphaScheduledTaskDefinition-${this.account}-${this.region}`,
                cpu: 1024,
                memoryLimitMiB: 2048,
                taskRole: scheduledTaskRunRole,
                executionRole: scheduledTaskRunRole,
                runtimePlatform: {
                    cpuArchitecture: ecs.CpuArchitecture.ARM64,
                    operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
                },
            });

            // intentional: do not replace with CDK reference
            const hardcodedS3Location =
                's3://deploymentbucket-12345a4solks4a7cab4205857a8c7r06796aa66a/pipelines_aggregate_transform_1234579/a12r5a11-cswd-1234-8a0a-ab5c2f2fc721_aaa0eae2a1ad7b1b5bbdff/artifact';

            // Add container to task definition
            taskDefinition.addContainer('CodeTestContainer', {
                containerName: 'CodeTestContainer',
                image: ecs.ContainerImage.fromRegistry(
                    'public.ecr.aws/amazonlinux/amazonlinux:latest',
                ),
                essential: true,
                environment: {
                    SCHEMA_TYPE: 'Generic',
                    TEST_SELECTOR: 'scheduled.*Test',
                    RUNTIME: 'python3',
                    EXECUTION_COMMAND: 'testPlatform/runTests.sh',
                    HANDLER: 'FargateHandler',
                    FARGATE_RUN_LOG_GROUP: '/aws/fargate/scheduled-tests',
                    FARGATE_RUN_LOG_STREAM_NAME: 'scheduled-tests',
                    CANARY_TESTS_REGION: 'us-east-1',
                    CANARY_TESTS_IS_PROD: 'true',
                    CANARY_ACCOUNT_ID: this.account,
                    S3_LOCATION: hardcodedS3Location, // intentional: schema specifies this value — do not replace with CDK reference
                    DOWNLOAD_TO: '/download/scheduled-test',
                    EXTRACT_TO: '/workspace/scheduled-test',
                    FARGATE_RUN_WORKSPACE_DIR: '/workspace/scheduled-test',
                    TIMEOUT: '54000000000',
                    FARGATE_RUN_TIMEOUT_VALUE: '54000000000',
                    CUSTOM_BOOTSTRAP_COMMAND:
                        'echo "No pre-test setup command or script provided. Skipping pre-test setup phase."',
                    ECS_CONTAINER_STOP_TIMEOUT: '300',
                    FARGATE_PLATFORM_VERSION: 'LATEST',
                    REPORT_TEST_ARTIFACTS: 'false',
                    TOOL_OPTIONS: '',
                },
                logging: ecs.LogDrivers.awsLogs({
                    logGroup: quartzTaskLogGroup,
                    streamPrefix: 'scheduled-tests',
                }),
            });

            // EventBridge Rule - Monthly cron schedule
            const monthlyQuartzRule = new events.Rule(this, 'MonthlyQuartzRule', {
                ruleName: 'QuartzService-MonthlyScheduledRule',
                description: 'Monthly EventBridge rule to trigger scheduled ECS task',
                schedule: events.Schedule.expression('cron(05 23 27 * ? *)'),
                enabled: true,
            });

            // Add ECS task as target to EventBridge rule
            monthlyQuartzRule.addTarget(
                new targets.EcsTask({
                    cluster: cluster,
                    taskDefinition: taskDefinition,
                    role: eventBridgeRole,
                    launchType: ecs.LaunchType.FARGATE,
                    platformVersion: ecs.FargatePlatformVersion.LATEST,
                    subnetSelection: { subnetType: ec2.SubnetType.PUBLIC },
                    securityGroups: [securityGroup],
                    assignPublicIp: true,
                }),
            );

            // Stack Exports
            StackUtils.exportStack(
                this,
                'DeploymentBucketName',
                deploymentBucket.bucketName,
                'The name of the S3 deployment bucket',
            );

            StackUtils.exportStack(
                this,
                'QuartzTaskLogGroupName',
                quartzTaskLogGroup.logGroupName,
                'The name of the CloudWatch Log Group for scheduled tasks',
            );

            StackUtils.exportStack(this, 'EcsClusterName', cluster.clusterName, 'The name of the ECS cluster');

            StackUtils.exportStack(
                this,
                'TaskDefinitionArn',
                taskDefinition.taskDefinitionArn,
                'The ARN of the ECS task definition',
            );

            StackUtils.exportStack(
                this,
                'EventBridgeRuleName',
                monthlyQuartzRule.ruleName,
                'The name of the EventBridge rule',
            );
    }
}
