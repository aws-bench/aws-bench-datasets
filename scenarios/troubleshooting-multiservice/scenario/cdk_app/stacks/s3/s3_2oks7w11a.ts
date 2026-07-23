import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda_event_sources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';
import * as logs from 'aws-cdk-lib/aws-logs';

/*
 * Stack ID: s3-2oks7w11a
 *
 * 0814e961-6e84-432b-b56f-038704ea9060
 *
 * What the stack does:
 * 1. S3 buckets for clickstream data storage (main, munged, access logs, EMR logs)
 * 2. KMS key for bucket encryption
 * 3. IAM roles for EMR workloads, operations access, and external consumer access
 * 4. Lambda function for QuartzStream certification triggered by SQS
 * 5. SQS queues for event processing and work distribution
 * 6. VPC for application networking
 *
 * Intentional bug: The KMS key policy grants kms:Decrypt and kms:GenerateDataKey only to
 * Workhorse, basalt, and onyx. The legacy roles (legacy-flint-s3-read, legacy-cobalt) have
 * kms:Decrypt in their IAM policies but are not in the key policy. For customer managed keys,
 * both the key policy and the IAM policy must allow the action — the IAM policy alone is
 * insufficient. GetObject calls by the legacy roles fail with AccessDenied at the KMS layer.
 */

export class S3_2oks7w11a extends cdk.Stack {

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);
        // KMS Key for bucket encryption
        // Key policy starts with root admin only. The data-plane statement (granting
        // Workhorse, basalt, onyx kms:Decrypt/GenerateDataKey) is added post-deploy
        // by setup/setup_kms_s3_2oks7w11a.py to avoid circular dependencies and
        // invalid-principal errors on fresh accounts.
        const quartzKmsKey = new kms.Key(this, 'QuartzKmsKey', {
            enableKeyRotation: true,
            description: 'KMS key for Quartz bucket encryption',
            alias: `alias/quartz-${this.account}-${this.region}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            policy: new iam.PolicyDocument({
                statements: [
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        principals: [new iam.AccountRootPrincipal()],
                        actions: [
                            'kms:Create*', 'kms:Describe*', 'kms:Enable*', 'kms:List*',
                            'kms:Put*', 'kms:Update*', 'kms:Revoke*', 'kms:Disable*',
                            'kms:Get*', 'kms:Delete*', 'kms:ScheduleKeyDeletion',
                            'kms:CancelKeyDeletion', 'kms:TagResource', 'kms:UntagResource',
                        ],
                        resources: ['*'],
                    }),
                ],
            }),
        });

        // Access logs bucket (no encryption specified, using S3 managed)
        const accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
            bucketName: `quartz-access-logs-${this.account}-${this.region}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            versioned: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        // Main clickstream bucket with KMS encryption
        const clickstreamBucket = new s3.Bucket(this, 'ClickstreamBucket', {
            bucketName: `quartz.clickstream.${this.account}-${this.region}`,
            encryption: s3.BucketEncryption.KMS,
            encryptionKey: quartzKmsKey,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            versioned: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            serverAccessLogsBucket: accessLogsBucket,
            lifecycleRules: [
                {
                    enabled: true,
                    expiration: cdk.Duration.days(30),
                    prefix: 'data/',
                },
                {
                    enabled: true,
                    expiration: cdk.Duration.days(30),
                    prefix: 'manifest/',
                },
            ],
        });

        // Munged data bucket with KMS encryption
        const mungedBucket = new s3.Bucket(this, 'MungedBucket', {
            bucketName: `quartz.clickstream.munged.${this.account}-${this.region}`,
            encryption: s3.BucketEncryption.KMS,
            encryptionKey: quartzKmsKey,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            versioned: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            lifecycleRules: [
                {
                    enabled: true,
                    expiration: cdk.Duration.days(30),
                    prefix: 'data/',
                },
                {
                    enabled: true,
                    expiration: cdk.Duration.days(30),
                    prefix: 'manifest/',
                },
            ],
        });

        // EMR logs bucket with versioning and replication config
        const emrLogsBucket = new s3.Bucket(this, 'EmrLogsBucket', {
            bucketName: `emr-cluster-logs-${this.account}-${this.region}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            versioned: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            lifecycleRules: [
                {
                    enabled: true,
                    expiration: cdk.Duration.days(90),
                },
            ],
        });

        // Harden the autoDeleteObjects handler with identity-based S3 grants.
        // By default the handler role's ONLY S3 access is the grant each bucket
        // policy gives its exact role ARN. If that grant is stale or gone at
        // delete time, the handler fails its first call (s3:GetBucketTagging)
        // with AccessDenied, the stack delete force-abandons these FIXED-NAME
        // buckets, and every later deploy fails changeset validation with
        // "already exists" — an unrecoverable reset->redeploy loop. Granting
        // the role directly removes the dependence on bucket-policy survival.
        // (S3 data-plane only; the intentional KMS-layer bug for legacy roles is
        // unrelated to and unaffected by these auto-delete handler permissions.)
        const autoDeleteProvider = this.node.tryFindChild(
            'Custom::S3AutoDeleteObjectsCustomResourceProvider',
        ) as cdk.CustomResourceProviderBase | undefined;
        autoDeleteProvider?.addToRolePolicy({
            Effect: 'Allow',
            Action: ['s3:GetBucket*', 's3:List*', 's3:DeleteObject*', 's3:PutBucketPolicy'],
            Resource: [
                accessLogsBucket.bucketArn,
                `${accessLogsBucket.bucketArn}/*`,
                clickstreamBucket.bucketArn,
                `${clickstreamBucket.bucketArn}/*`,
                mungedBucket.bucketArn,
                `${mungedBucket.bucketArn}/*`,
                emrLogsBucket.bucketArn,
                `${emrLogsBucket.bucketArn}/*`,
            ],
        });

        // Quartz Workhorse IAM Role for EMR
        const workhorseRole = new iam.Role(this, 'WorkhorseRole', {
            roleName: `Quartz-Workhorse-${this.account}-${this.region}`,
            assumedBy: new iam.CompositePrincipal(
                new iam.ServicePrincipal('elasticmapreduce.amazonaws.com'),
                new iam.ServicePrincipal('s3.amazonaws.com'),
                new iam.ServicePrincipal('ec2.amazonaws.com'),
            ),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AWSKeyManagementServicePowerUser'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonVPCCrossAccountNetworkInterfaceOperations'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLambdaInsightsExecutionRolePolicy'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEMRFullAccessPolicy_v2'),
            ],
        });

        // Inline policies for Workhorse role
        workhorseRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['kms:*'],
                resources: ['*'],
            }),
        );

        workhorseRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['s3:ListBucket', 's3:GetObject', 's3:PutObject', 's3:DeleteObject'],
                resources: [
                    clickstreamBucket.bucketArn,
                    `${clickstreamBucket.bucketArn}/*`,
                    mungedBucket.bucketArn,
                    `${mungedBucket.bucketArn}/*`,
                ],
            }),
        );

        // Operations Access Role
        const operationsRole = new iam.Role(this, 'OperationsRole', {
            roleName: `OperationsAccess-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEMRFullAccessPolicy_v2'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSQSFullAccess'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonElastiCacheFullAccess'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchFullAccessV2'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess'),
            ],
        });

        // Deny SQS delete operations
        operationsRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.DENY,
                actions: ['sqs:DeleteMessage', 'sqs:DeleteQueue', 'sqs:PurgeQueue'],
                resources: ['*'],
            }),
        );

        // Allow operations
        operationsRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    'elasticmapreduce:*',
                    'iam:PassRole',
                    'execute-api:Invoke',
                    'kms:Decrypt',
                    'secretsmanager:GetSecretValue',
                    'servicediscovery:DiscoverInstances',
                    'ssm:StartSession',
                ],
                resources: ['*'],
            }),
        );

        // External Access Role
        const externalAccessRole = new iam.Role(this, 'ExternalAccessRole', {
            roleName: `ExternalAccess-${this.account}-${this.region}`,
            assumedBy: new iam.AccountPrincipal(this.account),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess')],
        });

        externalAccessRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['kms:Decrypt'],
                resources: ['*'],
            }),
        );

        // External Access Roles - stream data consumers within the owner account
        const externalAccountIds = [this.account];

        // Create stream access roles with managed policies
        const streamRoles: Record<string, iam.Role> = {};
        ['basalt', 'onyx'].forEach((accessType) => {
            // S3 access patterns based on access type
            const s3Patterns =
                accessType === 'basalt'
                    ? [
                          'data/region=*/name=devices-flint/*',
                          'manifest/region=*/name=devices-flint/*',
                          'data/region=*/name=clickstream-event-pt1h/*',
                          'manifest/region=*/name=clickstream-event-pt1h/*',
                          '*/clickstream-flint-*/*',
                          '*/clickstream-pflint-undecorated-basalt-*/*',
                      ]
                    : [
                          'data/region=*/name=devices-*-onyx/*',
                          'manifest/region=*/name=devices-*-onyx/*',
                          'data/region=*/name=clickstream-event-onyx-pt1h/*',
                          'manifest/region=*/name=clickstream-event-onyx-pt1h/*',
                          '*/clickstream-flint-onyx-*/*',
                          '*/clickstream-flint-ops-onyx-*/*',
                          '*/clickstream-pflint-undecorated-onyx-*/*',
                      ];

            // Build all S3 resources
            const allS3Resources: string[] = [];
            s3Patterns.forEach((pattern) => {
                allS3Resources.push(`${clickstreamBucket.bucketArn}/${pattern}`);
                allS3Resources.push(`${mungedBucket.bucketArn}/${pattern}`);
            });

            // Create a managed policy for this access type
            const managedPolicy = new iam.ManagedPolicy(
                this,
                `ExternalAccess${accessType.charAt(0).toUpperCase() + accessType.slice(1)}Policy`,
                {
                    managedPolicyName: `external-access-QuartzStream-${accessType}-policy-${this.account}-${this.region}`,
                    statements: [
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ['s3:ListBucket'],
                            resources: [clickstreamBucket.bucketArn, mungedBucket.bucketArn],
                        }),
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ['s3:GetObject'],
                            resources: allS3Resources,
                        }),
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ['kms:Decrypt'],
                            resources: [quartzKmsKey.keyArn],
                        }),
                    ],
                },
            );

            streamRoles[accessType] = new iam.Role(this, `ExternalAccess${accessType.charAt(0).toUpperCase() + accessType.slice(1)}Role`, {
                roleName: `external-access-QuartzStream-${accessType}-${this.account}-${this.region}`,
                assumedBy: new iam.CompositePrincipal(
                    ...externalAccountIds.map((id) => new iam.AccountPrincipal(id)),
                ),
                managedPolicies: [managedPolicy],
            });
        });

        // Legacy IAM Users (simulated as roles for CDK)
        let legacyFlintRole: iam.Role;
        const legacyUsers = ['flint-s3-read', 'cobalt'];
        legacyUsers.forEach((userName) => {
            const legacyUserRole = new iam.Role(this, `LegacyUser${userName.replace(/-/g, '')}Role`, {
                roleName: `legacy-${userName}-${this.account}-${this.region}`,
                assumedBy: new iam.AccountPrincipal(this.account),
            });

            legacyUserRole.addToPolicy(
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['s3:GetObject', 's3:ListBucket'],
                    resources: [
                        clickstreamBucket.bucketArn,
                        `${clickstreamBucket.bucketArn}/*`,
                        mungedBucket.bucketArn,
                        `${mungedBucket.bucketArn}/*`,
                    ],
                }),
            );

            legacyUserRole.addToPolicy(
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['kms:Decrypt'],
                    resources: [quartzKmsKey.keyArn],
                }),
            );

            if (userName === 'flint-s3-read') legacyFlintRole = legacyUserRole;
        });

        // Seed a test object into the clickstream bucket so GetObject calls can be tested end-to-end
        const seedDeployment = new s3deploy.BucketDeployment(this, 'SeedClickstreamObject', {
            sources: [s3deploy.Source.jsonData('data/test-object.json', { event: 'test' })],
            destinationBucket: clickstreamBucket,
            destinationKeyPrefix: '',
            prune: false,
            serverSideEncryption: s3deploy.ServerSideEncryption.AWS_KMS,
            serverSideEncryptionAwsKmsKeyId: quartzKmsKey.keyId,
        });
        // Grant the BucketDeployment Lambda data-plane KMS access (key has no root delegation)
        quartzKmsKey.addToResourcePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                principals: [seedDeployment.handlerRole],
                actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
                resources: ['*'],
            }),
        );

        // VPC for Lambda and EMR
        const vpc = new ec2.Vpc(this, 'ApplicationVpc', {
            vpcName: `application-vpc-${this.account}-${this.region}`,
            maxAzs: 3,
            natGateways: 1,
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

        // Dead Letter Queue for QuartzStream Tracker
        const streamTrackerDlq = new sqs.Queue(this, 'StreamTrackerDlq', {
            queueName: `streamTrackerDlq-${this.account}-${this.region}`,
            retentionPeriod: cdk.Duration.days(14),
        });

        // QuartzStream Tracker Queue
        const streamTrackerQueue = new sqs.Queue(this, 'StreamTrackerQueue', {
            queueName: `streamTrackerQueue-${this.account}-${this.region}`,
            visibilityTimeout: cdk.Duration.seconds(60),
            deadLetterQueue: {
                queue: streamTrackerDlq,
                maxReceiveCount: 3,
            },
        });

        // Note: SNS topic subscriptions from external account 111122223333 are not included
        // as we don't have cross-account permissions to subscribe to those topics.
        // In a real deployment, these would need to be configured with proper cross-account permissions.

        // Lambda execution role
        const lambdaRole = new iam.Role(this, 'CertifierLambdaRole', {
            roleName: `CertifierLambdaRole-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
            ],
        });

        // Grant Lambda access to SQS
        streamTrackerQueue.grantConsumeMessages(lambdaRole);

        // Certifier Lambda Function
        // Lambda function business logic not captured in trace — stub only
        const certifierLambdaLogGroup = new logs.LogGroup(this, 'CertifierLambdaLogGroup', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const certifierLambda = new lambda.Function(this, 'CertifierLambda', {
            logGroup: certifierLambdaLogGroup,
            functionName: `CertifierLambda-${this.account}-${this.region}`,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromInline('def handler(e, c): pass'),
            memorySize: 512,
            timeout: cdk.Duration.seconds(60),
            role: lambdaRole,
            vpc: vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            environment: {
                APP_NAME: 'quartz-stream',
                APP_BUCKET_NAME: clickstreamBucket.bucketName,
                APP_BUCKET_REGION: this.region,
                STAGE: 'prod',
            },
        });

        // Add SQS trigger to Lambda
        certifierLambda.addEventSource(
            new lambda_event_sources.SqsEventSource(streamTrackerQueue, {
                batchSize: 10,
            }),
        );

        // Work Runner Queues
        const workRunnerQueueNames = [
            'quartz-work-runner-queue',
            'quartz-work-runner-backfill-queue',
            'quartz-work-runner-dlq',
            'quartz-work-runner-onhold-queue',
            'devices-flint-work-runner-queue',
            'devices-flint-work-runner-backfill-queue',
            'devices-flint-work-runner-dlq',
            'devices-flint-work-runner-onhold-queue',
            'clickstream-flint-work-runner-queue',
        ];

        workRunnerQueueNames.forEach((queueName) => {
            new sqs.Queue(this, `WorkRunner${queueName.replace(/-/g, '')}`, {
                queueName: `${queueName}-${this.account}-${this.region}`,
                visibilityTimeout: cdk.Duration.seconds(300),
                retentionPeriod: cdk.Duration.days(14),
            });
        });

        // Stack Exports
        StackUtils.exportStack(
            this,
            'ClickstreamBucketName',
            clickstreamBucket.bucketName,
            'Quartz clickstream bucket name',
        );
        StackUtils.exportStack(
            this,
            'MungedBucketName',
            mungedBucket.bucketName,
            'Quartz munged data bucket name',
        );
        StackUtils.exportStack(this, 'AccessLogsBucketName', accessLogsBucket.bucketName, 'Access logs bucket name');
        StackUtils.exportStack(this, 'EmrLogsBucketName', emrLogsBucket.bucketName, 'EMR cluster logs bucket name');
        StackUtils.exportStack(this, 'KmsKeyId', quartzKmsKey.keyId, 'Quartz KMS key ID');
        StackUtils.exportStack(this, 'WorkhorseRoleArn', workhorseRole.roleArn, 'Quartz Workhorse role ARN');
        StackUtils.exportStack(this, 'WorkhorseRoleName', workhorseRole.roleName, 'Quartz Workhorse role name');
        StackUtils.exportStack(this, 'StreamTrackerQueueUrl', streamTrackerQueue.queueUrl, 'Stream tracker queue URL');
        StackUtils.exportStack(
            this,
            'CertifierLambdaArn',
            certifierLambda.functionArn,
            'Certifier Lambda function ARN',
        );
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'Application VPC ID');
        StackUtils.exportStack(this, 'LegacyFlintRoleName', legacyFlintRole!.roleName, 'Legacy flint-s3-read role name');
        StackUtils.exportStack(this, 'BasaltRoleName', streamRoles['basalt'].roleName, 'External access basalt role name');
        StackUtils.exportStack(this, 'OnyxRoleName', streamRoles['onyx'].roleName, 'External access onyx role name');
    }
}
