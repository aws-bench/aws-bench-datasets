import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: s3_uijodjso5
 *
 * The stack creates the following resources:
 * 1. S3 bucket with complex permissions and policies
 * 2. Multiple IAM users with conflicting permissions
 * 3. Scattered files across multiple directories with typos
 * 4. Bucket policies that cause credential confusion
 */

export class s3_uijodjso5 extends cdk.Stack {
    private readonly accountId: string;
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);
        this.accountId = this.account;

        // Create S3 bucket with versioning and complex settings
        const bucket = new s3.Bucket(this, 'S3Bucket', {
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            lifecycleRules: [
                {
                    id: 'DeleteOldVersions',
                    noncurrentVersionExpiration: cdk.Duration.days(30),
                },
            ],
        });

        // Create IAM user that works for STS but has S3 issues
        const problematicUser = new iam.User(this, 'ProblematicUser', {
            userName: `s3-test-user-${this.accountId}`,
        });

        // Attach inline policy to user
        problematicUser.attachInlinePolicy(
            new iam.Policy(this, 'ProblematicUserPolicy', {
                document: new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ['sts:GetCallerIdentity', 'sts:GetAccessKeyInfo'],
                            resources: ['*'],
                        }),
                        // Deliberately restrictive S3 permissions that cause issues
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ['s3:ListBucket'],
                            resources: [bucket.bucketArn],
                            conditions: {
                                StringEquals: {
                                    's3:prefix': ['source/', 'sourc/'],
                                },
                            },
                        }),
                        // Allow basic S3 operations but with some restrictions
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
                            resources: [`${bucket.bucketArn}/sourc/*`, `${bucket.bucketArn}/source/*`],
                        }),
                        // Deny operations on other paths to create confusion
                        new iam.PolicyStatement({
                            effect: iam.Effect.DENY,
                            actions: ['s3:*'],
                            resources: [`${bucket.bucketArn}/temp/*`, `${bucket.bucketArn}/backup/*`],
                        }),
                    ],
                }),
            }),
        );

        // Add bucket policy that creates some confusion but allows cleanup
        bucket.addToResourcePolicy(
            new iam.PolicyStatement({
                sid: 'RestrictiveAccess',
                effect: iam.Effect.DENY,
                principals: [new iam.AnyPrincipal()],
                actions: ['s3:DeleteBucket'],
                resources: [bucket.bucketArn],
                conditions: {
                    StringNotEquals: {
                        'aws:PrincipalTag/Environment': 'Production',
                    },
                },
            }),
        );

        // Deploy files to the "wrong" directory (sourc instead of source)
        const oldFiles1 = new s3deploy.BucketDeployment(this, 'OldFiles1', {
            sources: [
                s3deploy.Source.data('config.json', JSON.stringify({ env: 'prod', version: '1.0' })),
                s3deploy.Source.data('data.csv', 'id,name,value\n1,test,100\n2,prod,200'),
                s3deploy.Source.data('readme.md', '# Old Configuration\nThis is outdated'),
            ],
            destinationBucket: bucket,
            destinationKeyPrefix: 'sourc/config/',
        });

        const oldFiles2 = new s3deploy.BucketDeployment(this, 'OldFiles2', {
            sources: [
                s3deploy.Source.data('app.log', '[2024-01-01] Application started\n[2024-01-01] Processing data'),
                s3deploy.Source.data('error.log', '[2024-01-01] ERROR: Connection failed'),
                s3deploy.Source.data('metrics.json', JSON.stringify({ cpu: 80, memory: 60 })),
            ],
            destinationBucket: bucket,
            destinationKeyPrefix: 'sourc/logs/',
        });

        const oldFiles3 = new s3deploy.BucketDeployment(this, 'OldFiles3', {
            sources: [
                s3deploy.Source.data('backup.sql', 'CREATE TABLE users (id INT, name VARCHAR(50));'),
                s3deploy.Source.data('schema.xml', '<?xml version="1.0"?><schema><table>users</table></schema>'),
            ],
            destinationBucket: bucket,
            destinationKeyPrefix: 'sourc/database/',
        });

        // Scatter some files in other wrong locations
        const scatteredFiles1 = new s3deploy.BucketDeployment(this, 'ScatteredFiles1', {
            sources: [
                s3deploy.Source.data('temp.txt', 'temporary file'),
                s3deploy.Source.data('old_backup.zip', 'fake zip content'),
            ],
            destinationBucket: bucket,
            destinationKeyPrefix: 'sourc/temp/',
        });

        const scatteredFiles2 = new s3deploy.BucketDeployment(this, 'ScatteredFiles2', {
            sources: [
                s3deploy.Source.data('legacy.dat', 'legacy data format'),
                s3deploy.Source.data('archive.tar', 'archived files'),
            ],
            destinationBucket: bucket,
            destinationKeyPrefix: 'sourc/archive/',
        });

        // Create the destination folder with some old files that should be removed
        const correctFolder = new s3deploy.BucketDeployment(this, 'DestinationFolder', {
            sources: [
                s3deploy.Source.data('.gitkeep', ''),
                // Old files from 2022-2023 that should be removed (older than 1 year)
                s3deploy.Source.data(
                    'old_config_2022.json',
                    JSON.stringify({ env: 'old', version: '0.5', created: '2022-06-15' }),
                ),
                s3deploy.Source.data('legacy_data_2023.csv', 'id,old_name,old_value\n1,legacy,50'),
                s3deploy.Source.data('deprecated_2023.log', '[2023-03-01] This file is deprecated'),
            ],
            destinationBucket: bucket,
            destinationKeyPrefix: 'source/',
        });

        // Add more old files in subdirectories of the destination
        const oldDestFiles = new s3deploy.BucketDeployment(this, 'OldDestFiles', {
            sources: [
                s3deploy.Source.data('archive_2022.zip', 'old archive from 2022'),
                s3deploy.Source.data('backup_2023_01.sql', 'CREATE TABLE old_users (id INT);'),
                s3deploy.Source.data('temp_2023.tmp', 'temporary file from last year'),
            ],
            destinationBucket: bucket,
            destinationKeyPrefix: 'source/old/',
        });

        // Create additional IAM role that appears helpful but has permission gaps
        const s3AccessRole = new iam.Role(this, 'S3AccessRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            inlinePolicies: {
                S3Policy: new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ['s3:ListBucket', 's3:GetBucketLocation'],
                            resources: [bucket.bucketArn],
                        }),
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ['s3:GetObject', 's3:PutObject'],
                            resources: [`${bucket.bucketArn}/*`],
                        }),
                        // Missing DeleteObject - this creates the challenge
                    ],
                }),
            },
        });

        // Apply removal policy to IAM resources
        problematicUser.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
        s3AccessRole.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        StackUtils.exportStack(this, 'BucketName', bucket.bucketName);
        StackUtils.exportStack(this, 'FolderPath', `s3://${bucket.bucketName}/sourc`);
        StackUtils.exportStack(this, 'DestinationFolderPath', `s3://${bucket.bucketName}/source`);
        StackUtils.exportStack(this, 'BucketARN', bucket.bucketArn);
        StackUtils.exportStack(this, 'ProblematicUserArn', problematicUser.userArn);
        StackUtils.exportStack(this, 'S3AccessRoleArn', s3AccessRole.roleArn);

        // Export confusing information that might mislead the agent
        StackUtils.exportStack(this, 'Region', this.region);
        StackUtils.exportStack(this, 'AccountId', this.accountId);
        StackUtils.exportStack(this, 'TotalFilesInSource', '10'); // Files to move from sourc/
        StackUtils.exportStack(this, 'OldFilesInDest', '7'); // Old files in source/ to be removed
    }
}
