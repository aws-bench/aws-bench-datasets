import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Glue ETL Pipeline Stack
 *
 * Converted from aws-cdk-examples/typescript/codepipeline-glue-deploy
 *
 * Creates:
 * 1. CodeCommit Repository for ETL source code
 * 2. KMS Key for pipeline artifact encryption (with key rotation)
 * 3. S3 Bucket for pipeline artifact store (KMS encrypted, SSL enforced)
 * 4. IAM Role for Glue ETL jobs
 * 5. Lambda Function to deploy and launch Glue ETL jobs
 * 6. CodePipeline V2 with Source -> Deploy stages
 */

export class GlueEtlPipelineStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const glueJobName = `etl-job-${this.account}-${this.region}`;

        const etlRepository = new codecommit.Repository(this, 'EtlRepository', {
            repositoryName: `etl-repository-${this.account}-${this.region}`,
            description: 'ETL source code repository for Glue jobs',
        });
        etlRepository.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        const pipelineArtifactStoreEncryptionKey = new kms.Key(this, 'PipelineArtifactStoreEncryptionKey', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            enableKeyRotation: true,
        });

        const pipelineArtifactStoreBucket = new s3.Bucket(this, 'PipelineArtifactStoreBucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            encryption: s3.BucketEncryption.KMS,
            encryptionKey: pipelineArtifactStoreEncryptionKey,
            serverAccessLogsPrefix: 'access-logs',
            enforceSSL: true,
        });

        const glueRole = new iam.Role(this, 'GlueRole', {
            assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
        });

        glueRole.addToPrincipalPolicy(
            new iam.PolicyStatement({
                actions: ['glue:CreateJob', 'glue:StartJobRun'],
                resources: [`arn:aws:glue:${this.region}:${this.account}:job/${glueJobName}*`],
            }),
        );

        pipelineArtifactStoreEncryptionKey.grantEncryptDecrypt(glueRole);
        pipelineArtifactStoreBucket.grantReadWrite(glueRole);

        const etlLaunchFunction = new lambda.Function(this, 'EtlLaunchFunction', {
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/glue-etl-launch')),
            handler: 'index.lambda_handler',
            runtime: lambda.Runtime.PYTHON_3_12,
            environment: {
                REPOSITORY_NAME: etlRepository.repositoryName,
                FILENAME: 'etl.py',
            },
            timeout: cdk.Duration.minutes(5),
        });

        etlLaunchFunction.role?.addToPrincipalPolicy(
            new iam.PolicyStatement({
                actions: ['iam:PassRole'],
                resources: [glueRole.roleArn],
            }),
        );

        etlLaunchFunction.role?.addToPrincipalPolicy(
            new iam.PolicyStatement({
                actions: ['glue:CreateJob', 'glue:StartJobRun'],
                resources: [`arn:aws:glue:${this.region}:${this.account}:job/${glueJobName}*`],
            }),
        );

        etlRepository.grantRead(etlLaunchFunction);
        pipelineArtifactStoreBucket.grantReadWrite(etlLaunchFunction.role!);
        pipelineArtifactStoreEncryptionKey.grantEncryptDecrypt(etlLaunchFunction.role!);

        const pipelineArtifactStore = new codepipeline.Artifact();

        const pipelineResource = new codepipeline.Pipeline(this, 'Pipeline', {
            pipelineName: `glue-etl-pipeline-${this.account}-${this.region}`,
            artifactBucket: pipelineArtifactStoreBucket,
            enableKeyRotation: true,
            pipelineType: codepipeline.PipelineType.V2,
            stages: [
                {
                    stageName: 'Source',
                    actions: [
                        new codepipeline_actions.CodeCommitSourceAction({
                            actionName: 'Source',
                            repository: etlRepository,
                            branch: 'main',
                            output: pipelineArtifactStore,
                        }),
                    ],
                },
                {
                    stageName: 'Deploy',
                    actions: [
                        new codepipeline_actions.LambdaInvokeAction({
                            actionName: 'Deploy',
                            lambda: etlLaunchFunction,
                            inputs: [pipelineArtifactStore],
                            userParameters: {
                                glue_job_name: glueJobName,
                                glue_role: glueRole.roleName,
                            },
                        }),
                    ],
                },
            ],
        });
        pipelineResource.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        etlRepository.grantPull(pipelineResource.role);
        etlLaunchFunction.grantInvoke(pipelineResource.role);
        pipelineArtifactStoreEncryptionKey.grantEncryptDecrypt(pipelineResource.role);

        StackUtils.exportStack(this, 'PipelineName', pipelineResource.pipelineName, 'CodePipeline name');
        StackUtils.exportStack(this, 'PipelineArn', pipelineResource.pipelineArn, 'CodePipeline ARN');
        StackUtils.exportStack(this, 'CodeCommitRepoName', etlRepository.repositoryName, 'CodeCommit ETL repository name');
        StackUtils.exportStack(this, 'CodeCommitRepoArn', etlRepository.repositoryArn, 'CodeCommit ETL repository ARN');
        StackUtils.exportStack(this, 'GlueJobName', glueJobName, 'Glue ETL job name pattern');
        StackUtils.exportStack(this, 'LambdaFunctionName', etlLaunchFunction.functionName, 'ETL launch Lambda function name');
        StackUtils.exportStack(this, 'ArtifactBucketName', pipelineArtifactStoreBucket.bucketName, 'S3 artifact bucket name');
    }
}
