import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: s3_3r8jz453a
 *
 * The stack creates the following resources:
 *
 * 1. 1 S3 bucket with problematic WAL configuration
 * 2. Adds a statement to the resource policy that blocks all S3 operations that EMR needs during cluster startup
 * 3. Exports stack information
 */

export class s3_3r8jz453a extends cdk.Stack {
    private readonly accountId: string;
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);
        this.accountId = this.account;

        // S3 bucket with problematic WAL configuration
        const walBucket = new s3.Bucket(this, 'WALBucket', {
            versioned: false, // WAL requires versioning but disabled
            objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
            encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            publicReadAccess: false, // Changed to false to avoid policy conflicts
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // Use default blocking
            lifecycleRules: [
                {
                    id: 'ConflictingWALRule',
                    enabled: true,
                    expiration: cdk.Duration.days(1), // Too aggressive for WAL
                    abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
                    noncurrentVersionExpiration: cdk.Duration.days(1),
                },
            ],
            cors: [
                {
                    allowedMethods: [s3.HttpMethods.DELETE, s3.HttpMethods.PUT], // Problematic for WAL integrity
                    allowedOrigins: ['*'],
                    allowedHeaders: ['*'],
                },
            ],
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        walBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Block ALL S3 operations that EMR needs during cluster startup
        // Block EMR service and instance roles specifically
        walBucket.addToResourcePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.DENY,
                principals: [
                    new iam.ServicePrincipal('elasticmapreduce.amazonaws.com'),
                    new iam.AccountRootPrincipal(),
                ],
                actions: ['s3:*'],
                resources: [walBucket.bucketArn, `${walBucket.bucketArn}/*`],
                conditions: {
                    StringLike: {
                        'aws:PrincipalArn': [
                            `arn:aws:iam::${this.account}:role/*EMR*`,
                            `arn:aws:iam::${this.account}:role/*emr*`,
                            `arn:aws:iam::${this.account}:role/EMR_EC2_DefaultRole`,
                            `arn:aws:iam::${this.account}:role/EMR_DefaultRole`,
                        ],
                    },
                },
            }),
        );

        // Export stack information
        StackUtils.exportStack(this, 'WALBucketName', walBucket.bucketName);
    }
}
