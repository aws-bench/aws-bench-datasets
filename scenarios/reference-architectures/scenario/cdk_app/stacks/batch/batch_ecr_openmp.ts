import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as batch from 'aws-cdk-lib/aws-batch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Batch ECR OpenMP Stack
 *
 * Converted from aws-cdk-examples/typescript/batch-ecr-openmp
 *
 * Creates:
 * 1. ECR Repository for OpenMP benchmark images
 * 2. VPC with public and private subnets
 * 3. Security Group for Batch compute environment
 * 4. IAM Roles for Batch service, EC2 instances, and job execution
 * 5. Instance Profile for EC2 instances
 * 6. Batch Compute Environment (EC2, MANAGED)
 * 7. Batch Job Queue
 * 8. Batch Job Definition
 * 9. CloudWatch Log Group for benchmark logs
 * 10. Lambda Function to submit batch jobs
 */

export class BatchEcrOpenmpStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // ECR Repository
        const repository = new ecr.Repository(this, 'OpenMPBenchmarkRepo', {
            repositoryName: `openmp-benchmark-${this.account}-${this.region}`,
            lifecycleRules: [
                {
                    maxImageCount: 10,
                    description: 'Keep only 10 images',
                },
            ],
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            emptyOnDelete: true,
        });

        // VPC
        const vpc = new ec2.Vpc(this, 'BatchVpc', {
            maxAzs: 2,
            natGateways: 1,
            subnetConfiguration: [
                {
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                    cidrMask: 24,
                },
                {
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                    cidrMask: 24,
                },
            ],
        });

        // Security Group for Batch
        const batchSecurityGroup = new ec2.SecurityGroup(this, 'BatchSecurityGroup', {
            vpc,
            description: 'Security group for AWS Batch compute environment',
            allowAllOutbound: true,
        });

        // IAM Role - Batch Service Role
        const batchServiceRole = new iam.Role(this, 'BatchServiceRole', {
            assumedBy: new iam.ServicePrincipal('batch.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSBatchServiceRole'),
            ],
        });

        // IAM Role - EC2 Instance Role
        const ec2InstanceRole = new iam.Role(this, 'BatchEC2InstanceRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName(
                    'service-role/AmazonEC2ContainerServiceforEC2Role',
                ),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
            ],
        });

        // Instance Profile
        const instanceProfile = new iam.CfnInstanceProfile(this, 'BatchInstanceProfile', {
            roles: [ec2InstanceRole.roleName],
        });

        // Batch creates an implicit launch template when none is provided.
        // Supply one explicitly so any compute instances require IMDSv2.
        const launchTemplate = new ec2.LaunchTemplate(this, 'BatchLaunchTemplate', {
            requireImdsv2: true,
        });

        // IAM Role - Batch Job Role
        const batchJobRole = new iam.Role(this, 'BatchJobRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName(
                    'service-role/AmazonECSTaskExecutionRolePolicy',
                ),
            ],
        });

        // Batch Compute Environment
        const computeEnvironment = new batch.CfnComputeEnvironment(this, 'OpenMPComputeEnv', {
            type: 'MANAGED',
            serviceRole: batchServiceRole.roleArn,
            computeResources: {
                type: 'EC2',
                instanceTypes: ['c6i.large', 'c6i.xlarge', 'c6i.2xlarge', 'c5.large', 'c5.xlarge'],
                minvCpus: 0,
                maxvCpus: 256,
                desiredvCpus: 0,
                subnets: vpc.privateSubnets.map((subnet) => subnet.subnetId),
                securityGroupIds: [batchSecurityGroup.securityGroupId],
                instanceRole: instanceProfile.attrArn,
                launchTemplate: {
                    launchTemplateId: launchTemplate.launchTemplateId,
                    version: launchTemplate.latestVersionNumber,
                },
            },
        });
        computeEnvironment.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Batch Job Queue
        const jobQueue = new batch.CfnJobQueue(this, 'OpenMPJobQueue', {
            jobQueueName: `openmp-job-queue-${this.account}-${this.region}`,
            priority: 1,
            computeEnvironmentOrder: [
                {
                    computeEnvironment: computeEnvironment.ref,
                    order: 1,
                },
            ],
        });
        jobQueue.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Batch Job Definition
        const jobDefinition = new batch.CfnJobDefinition(this, 'OpenMPJobDefinition', {
            type: 'container',
            jobDefinitionName: `openmp-benchmark-job-${this.account}-${this.region}`,
            containerProperties: {
                image: repository.repositoryUri,
                vcpus: 2,
                memory: 2048,
                jobRoleArn: batchJobRole.roleArn,
            },
        });
        jobDefinition.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // CloudWatch Log Group
        const logGroup = new logs.LogGroup(this, 'OpenMPLogGroup', {
            logGroupName: '/aws/batch/openmp-benchmark',
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Lambda Function to submit batch jobs
        const submitJobFunction = new lambda.Function(this, 'SubmitBatchJobFunction', {
            runtime: lambda.Runtime.PYTHON_3_11,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/batch-submit-job')),
            environment: {
                JOB_QUEUE: jobQueue.ref,
                JOB_DEFINITION: jobDefinition.ref,
            },
            timeout: cdk.Duration.seconds(60),
        });

        // Grant Lambda permission to submit batch jobs
        submitJobFunction.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['batch:SubmitJob'],
                resources: [
                    jobQueue.ref,
                    jobDefinition.ref,
                ],
            }),
        );

        // Exports
        StackUtils.exportStack(this, 'EcrRepositoryUri', repository.repositoryUri, 'ECR repository URI for OpenMP benchmark images');
        StackUtils.exportStack(this, 'EcrRepositoryName', repository.repositoryName, 'ECR repository name');
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'VPC ID for Batch compute environment');
        StackUtils.exportStack(this, 'ComputeEnvironmentArn', computeEnvironment.attrComputeEnvironmentArn, 'Batch compute environment ARN');
        StackUtils.exportStack(this, 'JobQueueArn', jobQueue.attrJobQueueArn, 'Batch job queue ARN');
        StackUtils.exportStack(this, 'JobQueueName', jobQueue.jobQueueName!, 'Batch job queue name');
        StackUtils.exportStack(this, 'JobDefinitionArn', jobDefinition.ref, 'Batch job definition ARN');
        StackUtils.exportStack(this, 'FunctionName', submitJobFunction.functionName, 'Lambda function name for submitting batch jobs');
        StackUtils.exportStack(this, 'LogGroupName', logGroup.logGroupName, 'CloudWatch log group name for benchmark logs');
        StackUtils.exportStack(this, 'MaxVCpus', '256', 'Maximum vCPUs for the compute environment');
        StackUtils.exportStack(this, 'InstanceTypes', 'c6i.large,c6i.xlarge,c6i.2xlarge,c5.large,c5.xlarge', 'Instance types used in the compute environment');
    }
}
