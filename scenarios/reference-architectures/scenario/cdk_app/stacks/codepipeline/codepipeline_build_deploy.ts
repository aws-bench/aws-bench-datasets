import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as custom from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * CodePipeline Build Deploy Stack
 *
 * Converted from aws-cdk-examples/typescript/codepipeline-build-deploy
 *
 * Creates:
 * 1. VPC (10.50.0.0/16, maxAzs 2)
 * 2. ECR Repository
 * 3. ECS Cluster with Fargate TaskDefinition and Service behind internal ALB
 * 4. CodeCommit Repository
 * 5. CodeBuild Projects for testing and Docker build
 * 6. Lambda + AwsCustomResource to auto-trigger initial Docker build
 * 7. CodeDeploy ECS blue/green deployment
 * 8. CodePipeline V2 with Source -> Test -> Build -> Deploy stages
 */

export class CodePipelineBuildDeployStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // CodeCommit Repository
        const codeRepo = new codecommit.Repository(this, 'CodeRepo', {
            repositoryName: 'simple-code-repo',
            description: 'Source code repository for pipeline',
        });
        codeRepo.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // ECR Repository
        const ecrRepo = new ecr.Repository(this, 'AppEcrRepo', {
            repositoryName: `pipeline-app-${this.account}-${this.region}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            emptyOnDelete: true,
        });

        // ECS Fargate Task Definition
        const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
            cpu: 256,
            memoryLimitMiB: 512,
        });

        // Placeholder nginx image so the ECS service starts on first deploy.
        // CodePipeline will build + push to ecrRepo; CodeDeploy swaps task defs
        // to pull from there on subsequent blue/green deployments.
        taskDefinition.addContainer('web', {
            containerName: 'web',
            image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx:stable'),
            portMappings: [{ containerPort: 80 }],
            logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'web' }),
        });

        // CodeBuild Project for Docker build with all 8 environment variables
        // Original uses BuildSpec.fromSourceFilename('app/buildspec.yaml'). Inlined below.
        const buildProject = new codebuild.Project(this, 'BuildProject', {
            projectName: `pipeline-build-${this.account}-${this.region}`,
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    pre_build: {
                        commands: [
                            'cd app',
                            'echo Logging in to Amazon ECR...',
                            'aws --version',
                            'aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com',
                        ],
                    },
                    build: {
                        commands: [
                            'echo Building the Docker image...',
                            'docker build -t $IMAGE_REPO_NAME:$IMAGE_TAG .',
                            'docker tag $IMAGE_REPO_NAME:$IMAGE_TAG $AWS_ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG',
                        ],
                    },
                    post_build: {
                        commands: [
                            'echo Pushing the Docker image...',
                            'docker push $AWS_ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG',
                            'echo Container image to be used $REPOSITORY_URI:$IMAGE_TAG',
                            'sed -i "s|REPOSITORY_URI|${REPOSITORY_URI}|g" taskdef.json',
                            'sed -i "s|IMAGE_TAG|${IMAGE_TAG}|g" taskdef.json',
                            'sed -i "s|TASK_ROLE_ARN|${TASK_ROLE_ARN}|g" taskdef.json',
                            'sed -i "s|EXECUTION_ROLE_ARN|${EXECUTION_ROLE_ARN}|g" taskdef.json',
                            'sed -i "s|TASK_DEFINITION_ARN|${TASK_DEFINITION_ARN}|g" appspec.yaml',
                            'cat appspec.yaml && cat taskdef.json',
                            'cp appspec.yaml ../',
                            'cp taskdef.json ../',
                        ],
                    },
                },
                artifacts: {
                    files: ['appspec.yaml', 'taskdef.json'],
                },
            }),
            source: codebuild.Source.codeCommit({ repository: codeRepo }),
            environment: {
                privileged: true,
                environmentVariables: {
                    AWS_ACCOUNT_ID: { value: process.env?.CDK_DEFAULT_ACCOUNT || '' },
                    REGION: { value: process.env?.CDK_DEFAULT_REGION || '' },
                    IMAGE_TAG: { value: 'latest' },
                    IMAGE_REPO_NAME: { value: ecrRepo.repositoryName },
                    REPOSITORY_URI: { value: ecrRepo.repositoryUri },
                    TASK_DEFINITION_ARN: { value: taskDefinition.taskDefinitionArn },
                    TASK_ROLE_ARN: { value: taskDefinition.taskRole.roleArn },
                    EXECUTION_ROLE_ARN: { value: taskDefinition.executionRole?.roleArn },
                },
            },
        });

        // CodeBuild Project for tests
        // Original uses BuildSpec.fromSourceFilename('buildspec.yaml'). Inlined below.
        const testProject = new codebuild.Project(this, 'TestProject', {
            projectName: `pipeline-test-${this.account}-${this.region}`,
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    pre_build: {
                        commands: ['npm install'],
                    },
                    build: {
                        commands: ['npm run test', 'npm run build'],
                    },
                },
                reports: {
                    jest_reports: {
                        files: ['report.xml'],
                        'file-format': 'JUNITXML',
                        'base-directory': './',
                    },
                },
            }),
            source: codebuild.Source.codeCommit({ repository: codeRepo }),
            environment: {
                buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
            },
        });

        // Grant ECR permissions to build project
        ecrRepo.grantPullPush(buildProject);

        // Lambda Function for triggering initial CodeBuild
        const triggerFunction = new lambda.Function(this, 'TriggerBuildFunction', {
            architecture: lambda.Architecture.ARM_64,
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/codepipeline-trigger-build')),
            environment: {
                REGION: process.env.CDK_DEFAULT_REGION!,
                CODEBUILD_PROJECT_NAME: buildProject.projectName,
            },
            timeout: cdk.Duration.seconds(60),
            initialPolicy: [
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['codebuild:StartBuild'],
                    resources: [buildProject.projectArn],
                }),
            ],
        });

        // AwsCustomResource to auto-trigger the Lambda on stack creation
        const triggerLambda = new custom.AwsCustomResource(
            this,
            'BuildLambdaTrigger',
            {
                installLatestAwsSdk: true,
                policy: custom.AwsCustomResourcePolicy.fromStatements([
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        actions: ['lambda:InvokeFunction'],
                        resources: [triggerFunction.functionArn],
                    }),
                ]),
                onCreate: {
                    service: 'Lambda',
                    action: 'invoke',
                    physicalResourceId: custom.PhysicalResourceId.of('id'),
                    parameters: {
                        FunctionName: triggerFunction.functionName,
                        InvocationType: 'Event',
                    },
                },
                onUpdate: {
                    service: 'Lambda',
                    action: 'invoke',
                    parameters: {
                        FunctionName: triggerFunction.functionName,
                        InvocationType: 'Event',
                    },
                },
            },
        );

        // VPC
        const vpc = new ec2.Vpc(this, 'PipelineVpc', {
            ipAddresses: ec2.IpAddresses.cidr('10.50.0.0/16'),
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

        // Deploy VPC after the initial image build triggers
        vpc.node.addDependency(triggerLambda);

        // Security Group for ALB - restricted to VPC CIDR
        const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
            vpc,
            description: 'Security group for internal ALB',
            allowAllOutbound: true,
        });
        albSecurityGroup.addIngressRule(
            ec2.Peer.ipv4('10.50.0.0/16'),
            ec2.Port.tcp(80),
            'Allow HTTP from VPC CIDR only',
        );

        // Application Load Balancer (internal)
        const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
            vpc,
            internetFacing: false,
            securityGroup: albSecurityGroup,
        });

        // Blue target group
        const blueTargetGroup = new elbv2.ApplicationTargetGroup(this, 'BlueTargetGroup', {
            vpc,
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                path: '/',
                interval: cdk.Duration.seconds(30),
            },
        });

        // Green target group
        const greenTargetGroup = new elbv2.ApplicationTargetGroup(this, 'GreenTargetGroup', {
            vpc,
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                path: '/',
                interval: cdk.Duration.seconds(30),
            },
        });

        // Production listener
        const prodListener = alb.addListener('ProdListener', {
            port: 80,
            defaultTargetGroups: [blueTargetGroup],
        });

        // Test listener on port 8080
        const testListener = alb.addListener('TestListener', {
            port: 8080,
            defaultTargetGroups: [greenTargetGroup],
        });

        // Allow port 8080 from VPC CIDR for test listener
        albSecurityGroup.addIngressRule(
            ec2.Peer.ipv4('10.50.0.0/16'),
            ec2.Port.tcp(8080),
            'Allow test listener from VPC CIDR only',
        );

        // ECS Cluster
        const cluster = new ecs.Cluster(this, 'EcsCluster', {
            vpc,
            clusterName: `pipeline-cluster-${this.account}-${this.region}`,
            enableFargateCapacityProviders: true,
        });

        // ECS Fargate Service
        const service = new ecs.FargateService(this, 'FargateService', {
            cluster,
            taskDefinition,
            desiredCount: 1,
            serviceName: 'fargate-frontend-service',
            deploymentController: {
                type: ecs.DeploymentControllerType.CODE_DEPLOY,
            },
        });

        service.attachToApplicationTargetGroup(blueTargetGroup);

        // Pipeline artifacts
        const sourceOutput = new codepipeline.Artifact('SourceOutput');
        const buildOutput = new codepipeline.Artifact('BuildOutput');

        // CodeDeploy ECS Application
        const ecsApplication = new codedeploy.EcsApplication(this, 'EcsCodeDeployApp', {
            applicationName: `pipeline-ecs-app-${this.account}-${this.region}`,
        });

        // CodeDeploy ECS Deployment Group
        const deploymentGroup = new codedeploy.EcsDeploymentGroup(this, 'EcsDeploymentGroup', {
            application: ecsApplication,
            deploymentGroupName: `pipeline-ecs-dg-${this.account}-${this.region}`,
            service,
            blueGreenDeploymentConfig: {
                blueTargetGroup,
                greenTargetGroup,
                listener: prodListener,
                testListener,
            },
            deploymentConfig: codedeploy.EcsDeploymentConfig.ALL_AT_ONCE,
        });

        // CodePipeline V2
        const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
            pipelineName: `build-deploy-pipeline-${this.account}-${this.region}`,
            pipelineType: codepipeline.PipelineType.V2,
            stages: [
                {
                    stageName: 'Source',
                    actions: [
                        new codepipeline_actions.CodeCommitSourceAction({
                            actionName: 'CodeCommit_Source',
                            repository: codeRepo,
                            output: sourceOutput,
                            branch: 'main',
                        }),
                    ],
                },
                {
                    stageName: 'Test',
                    actions: [
                        new codepipeline_actions.CodeBuildAction({
                            actionName: 'Run_Tests',
                            project: testProject,
                            input: sourceOutput,
                        }),
                    ],
                },
                {
                    stageName: 'Build',
                    actions: [
                        new codepipeline_actions.CodeBuildAction({
                            actionName: 'Docker_Build',
                            project: buildProject,
                            input: sourceOutput,
                            outputs: [buildOutput],
                        }),
                    ],
                },
                {
                    stageName: 'Deploy',
                    actions: [
                        new codepipeline_actions.CodeDeployEcsDeployAction({
                            actionName: 'ECS_BlueGreen_Deploy',
                            deploymentGroup,
                            appSpecTemplateInput: buildOutput,
                            taskDefinitionTemplateInput: buildOutput,
                        }),
                    ],
                },
            ],
        });
        pipeline.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Exports
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'VPC ID for the pipeline infrastructure');
        StackUtils.exportStack(this, 'EcrRepositoryUri', ecrRepo.repositoryUri, 'ECR repository URI');
        StackUtils.exportStack(this, 'EcsClusterName', cluster.clusterName, 'ECS cluster name');
        StackUtils.exportStack(this, 'EcsClusterArn', cluster.clusterArn, 'ECS cluster ARN');
        StackUtils.exportStack(this, 'EcsServiceName', service.serviceName, 'ECS Fargate service name');
        StackUtils.exportStack(this, 'AlbDnsName', alb.loadBalancerDnsName, 'Internal ALB DNS name');
        StackUtils.exportStack(this, 'AlbArn', alb.loadBalancerArn, 'ALB ARN');
        StackUtils.exportStack(this, 'CodeCommitRepoName', codeRepo.repositoryName, 'CodeCommit repository name');
        StackUtils.exportStack(this, 'CodeCommitRepoArn', codeRepo.repositoryArn, 'CodeCommit repository ARN');
        StackUtils.exportStack(this, 'PipelineName', pipeline.pipelineName, 'CodePipeline name');
        StackUtils.exportStack(this, 'PipelineArn', pipeline.pipelineArn, 'CodePipeline ARN');
        StackUtils.exportStack(this, 'BuildProjectName', buildProject.projectName, 'CodeBuild Docker build project name');
        StackUtils.exportStack(this, 'TestProjectName', testProject.projectName, 'CodeBuild test project name');
        StackUtils.exportStack(this, 'DeploymentGroupName', deploymentGroup.deploymentGroupName, 'CodeDeploy deployment group name');
        StackUtils.exportStack(this, 'FunctionName', triggerFunction.functionName, 'Lambda trigger function name');
    }
}
