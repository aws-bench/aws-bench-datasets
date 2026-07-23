import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: cloudfront_t5s43s6ye
 * What the stack does:
 * 1. The stack creates an S3 bucket.
 * 2. The stack creates CloudFront distribution with the created bucket as origin.
 *
 */

export class cloudfront_t5s43s6ye extends cdk.Stack {
    private readonly accountId: string;

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        this.accountId = this.account;

        // Create an S3 bucket. ObjectOwnership=BUCKET_OWNER_PREFERRED keeps
        // ACLs enabled so CloudFront's standard (legacy) access logging can
        // grant the awslogsdelivery group write access; the modern S3 default
        // (BUCKET_OWNER_ENFORCED) disables ACLs and would make CloudFront
        // reject the bucket at distribution-create time.
        const bucket = new s3.Bucket(this, 'bucket', {
            bucketName: `bucket-qh4y5g2u4-${this.accountId}-${this.region}`,
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
        });

        // Harden the autoDeleteObjects handler with identity-based S3 grants.
        // By default the handler role's ONLY S3 access is the grant the bucket
        // policy gives its exact role ARN. If that grant is stale or gone at
        // delete time, the handler fails its first call (s3:GetBucketTagging)
        // with AccessDenied, the stack delete force-abandons this FIXED-NAME
        // bucket, and every later deploy fails changeset validation with
        // "already exists" — an unrecoverable reset->redeploy loop. Granting
        // the role directly removes the dependence on bucket-policy survival.
        const autoDeleteProvider = this.node.tryFindChild(
            'Custom::S3AutoDeleteObjectsCustomResourceProvider',
        ) as cdk.CustomResourceProviderBase | undefined;
        autoDeleteProvider?.addToRolePolicy({
            Effect: 'Allow',
            Action: ['s3:GetBucket*', 's3:List*', 's3:DeleteObject*', 's3:PutBucketPolicy'],
            Resource: [bucket.bucketArn, `${bucket.bucketArn}/*`],
        });

        // Create CloudFront distribution with the created bucket as origin
        const distribution = new cloudfront.Distribution(this, 'distribution', {
            defaultBehavior: {
                origin: new origins.S3Origin(bucket),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            },
            enableLogging: true,
            logBucket: bucket,
            comment: 'CloudFront distribution with logging in same bucket',
        });
        distribution.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        StackUtils.exportStack(
            this,
            'DistributionId',
            distribution.distributionId,
            'Id of the CloudFront distribution',
        );
        StackUtils.exportStack(this, 'BucketName', bucket.bucketName, 'Name of the S3 bucket');
    }
}
