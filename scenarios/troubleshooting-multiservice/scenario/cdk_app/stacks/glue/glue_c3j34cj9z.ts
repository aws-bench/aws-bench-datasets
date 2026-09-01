import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as glue from 'aws-cdk-lib/aws-glue';
import { Construct } from 'constructs';

import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: glue-c3j34cj9z
 *
 * 813b76e0-9c36-40b4-b929-0180b8859e8f
 *
 * What the stack does:
 * 1. Creates three S3 buckets:
 *    - basalt-data-onyx-data bucket for onyx data storage
 *    - basalt-data-glue-assets bucket for Glue scripts
 *    - basalt-data-glue-logs bucket for Glue job logs
 * 2. Creates an IAM role (BasaltDataGlueJobRole) for Glue job execution
 * 3. Creates a Glue job (BasaltDataAnalyzer-RoleReport)
 */

export class Glue_c3j34cj9z extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const flintDataBucket = new s3.Bucket(this, 'FlintDataBucket', {
            bucketName: `basalt-data-onyx-data-${this.account}-${this.region}-alpha`,
            versioned: false,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

        cdk.Tags.of(flintDataBucket).add('Environment', 'alpha');
        cdk.Tags.of(flintDataBucket).add('Service', 'basalt-data');

        const glueAssetsBucket = new s3.Bucket(this, 'GlueAssetsBucket', {
            bucketName: `basalt-data-glue-assets-${this.account}-${this.region}-alpha`,
            versioned: false,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

        cdk.Tags.of(glueAssetsBucket).add('Environment', 'alpha');
        cdk.Tags.of(glueAssetsBucket).add('Service', 'basalt-data');

        const glueLogsBucket = new s3.Bucket(this, 'GlueLogsBucket', {
            bucketName: `basalt-data-glue-logs-${this.account}-${this.region}-alpha`,
            versioned: false,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

        cdk.Tags.of(glueLogsBucket).add('Environment', 'alpha');
        cdk.Tags.of(glueLogsBucket).add('Service', 'basalt-data');

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
                flintDataBucket.bucketArn,
                `${flintDataBucket.bucketArn}/*`,
                glueAssetsBucket.bucketArn,
                `${glueAssetsBucket.bucketArn}/*`,
                glueLogsBucket.bucketArn,
                `${glueLogsBucket.bucketArn}/*`,
            ],
        });

        // IAM Role: Glue Job Execution Role
        const glueJobRole = new iam.Role(this, 'GlueJobRole', {
            roleName: `BasaltDataGlueJobRole-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole')],
        });

        // Grant Glue job role access to buckets
        glueAssetsBucket.grantRead(glueJobRole);
        flintDataBucket.grantReadWrite(glueJobRole);
        glueLogsBucket.grantWrite(glueJobRole);

        // Glue Job: BasaltDataAnalyzer-RoleReport
        const glueJob = new glue.CfnJob(this, 'BasaltDataAnalyzerJob', {
            name: `BasaltDataAnalyzer-RoleReport-${this.account}-${this.region}`,
            role: glueJobRole.roleArn,
            command: {
                name: 'glueetl',
                pythonVersion: '3',
                scriptLocation: `s3://${glueAssetsBucket.bucketName}/scripts/role_analyzer.py`,
            },
            glueVersion: '4.0',
            maxRetries: 0,
            timeout: 2880,
            defaultArguments: {
                '--enable-metrics': 'true',
                '--enable-continuous-cloudwatch-log': 'true',
                '--enable-continuous-log-filter': 'true',
                '--continuous-log-logGroup': `/aws-glue/jobs/${this.account}-${this.region}`,
                '--TempDir': `s3://${glueLogsBucket.bucketName}/temp/`,
                '--enable-spark-ui': 'true',
                '--spark-event-logs-path': `s3://${glueLogsBucket.bucketName}/spark-logs/`,
            },
            tags: {
                Environment: 'alpha',
                Service: 'basalt-data',
                Stack: 'BasaltDataAnalyzer-Glue-alpha',
            },
        });

        // Outputs
        StackUtils.exportStack(this, 'FlintDataBucketName', flintDataBucket.bucketName, 'Onyx data bucket');

        StackUtils.exportStack(this, 'GlueAssetsBucketName', glueAssetsBucket.bucketName, 'Glue assets bucket');

        StackUtils.exportStack(this, 'GlueLogsBucketName', glueLogsBucket.bucketName, 'Glue logs bucket');

        StackUtils.exportStack(this, 'GlueJobRoleArn', glueJobRole.roleArn, 'Glue job execution role ARN');

        StackUtils.exportStack(this, 'GlueJobName', glueJob.name || '', 'Glue job name');

        StackUtils.exportStack(this, 'DeploymentRegion', this.region, 'Region the stack is deployed to');

        StackUtils.exportStack(this, 'HomeRegion', 'us-east-1', 'Home region');
    }
}
