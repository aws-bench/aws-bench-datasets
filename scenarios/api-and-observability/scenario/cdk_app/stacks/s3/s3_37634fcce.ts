import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import { StackUtils } from '../../lib/shared';

export class s3_37634fcce extends cdk.Stack {
    public readonly analyticsBucket: s3.IBucket;
    public readonly archiveBucket: s3.IBucket;
    public readonly reportsBucket: s3.IBucket;

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // Create KMS key for S3 encryption
        const kmsKey = new kms.Key(this, 'AnalyticsKey', {
            description: 'KMS key for analytics bucket encryption',
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Analytics bucket in us-east-1
        this.analyticsBucket = new s3.Bucket(this, 'AnalyticsBucket', {
            bucketName: `quartz-analytics-beta-${this.account}-us-east-1`,
            versioned: true,
            encryption: s3.BucketEncryption.KMS,
            encryptionKey: kmsKey,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Archive bucket
        this.archiveBucket = new s3.Bucket(this, 'ArchiveBucket', {
            bucketName: `quartz-analytics-archive-${this.account}-us-east-1`,
            versioned: true,
            encryption: s3.BucketEncryption.KMS,
            encryptionKey: kmsKey,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            lifecycleRules: [
                {
                    transitions: [
                        {
                            storageClass: s3.StorageClass.GLACIER,
                            transitionAfter: cdk.Duration.days(90),
                        }
                    ]
                }
            ]
        });

        // Reports bucket
        this.reportsBucket = new s3.Bucket(this, 'ReportsBucket', {
            bucketName: `quartz-analytics-reports-${this.account}-us-east-1`,
            versioned: true,
            encryption: s3.BucketEncryption.KMS,
            encryptionKey: kmsKey,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
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
                this.analyticsBucket.bucketArn,
                `${this.analyticsBucket.bucketArn}/*`,
                this.archiveBucket.bucketArn,
                `${this.archiveBucket.bucketArn}/*`,
                this.reportsBucket.bucketArn,
                `${this.reportsBucket.bucketArn}/*`,
            ],
        });

        StackUtils.exportStack(this, 'AnalyticsBucketName', this.analyticsBucket.bucketName, 'Analytics S3 Bucket Name');
        StackUtils.exportStack(this, 'AnalyticsBucketArn', this.analyticsBucket.bucketArn, 'Analytics S3 Bucket ARN');
        StackUtils.exportStack(this, 'ArchiveBucketName', this.archiveBucket.bucketName, 'Archive S3 Bucket Name');
        StackUtils.exportStack(this, 'ReportsBucketName', this.reportsBucket.bucketName, 'Reports S3 Bucket Name');
        StackUtils.exportStack(this, 'KmsKeyId', kmsKey.keyId, 'KMS Key ID');
    }
}
