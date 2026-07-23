import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: cloudfront_492sidmdo
 * What the stack does:
 * 1. Creates S3 bucket for website content
 * 2. CloudFront distribution
 * 3. IAM role for CloudFront invalidations
 */

export class cloudfront_492sidmdo extends cdk.Stack {
    private readonly accountId: string;
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);
        this.accountId = this.account;

        // S3 bucket for website content
        const websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            bucketName: `cloudfront-bucket-1g3v4c-${this.accountId}-${this.region}`,
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
            Resource: [websiteBucket.bucketArn, `${websiteBucket.bucketArn}/*`],
        });

        // CloudFront distribution
        const distribution = new cloudfront.Distribution(this, 'Distribution', {
            defaultBehavior: {
                origin: new origins.S3Origin(websiteBucket),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
            },
            defaultRootObject: 'index.html',
            comment: 'Test distribution for invalidation testing',
        });
        distribution.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Deploy sample content
        new s3deploy.BucketDeployment(this, 'DeployWebsite', {
            sources: [
                s3deploy.Source.data(
                    'index.html',
                    '<html><body><h1>CloudFront Test Page</h1><p>Version 1.0</p></body></html>',
                ),
                s3deploy.Source.data(
                    'page1.html',
                    '<html><body><h1>Page 1</h1><p>Content for testing</p></body></html>',
                ),
                s3deploy.Source.data('page2.html', '<html><body><h1>Page 2</h1><p>More content</p></body></html>'),
            ],
            destinationBucket: websiteBucket,
            distribution,
            distributionPaths: ['/*'],
        });

        // IAM role for CloudFront invalidations
        const invalidationRole = new iam.Role(this, 'InvalidationRole', {
            assumedBy: new iam.AccountRootPrincipal(),
            inlinePolicies: {
                CloudFrontInvalidation: new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            actions: [
                                'cloudfront:CreateInvalidation',
                                'cloudfront:ListDistributions',
                                'cloudfront:GetDistribution',
                            ],
                            resources: ['*'],
                        }),
                    ],
                }),
            },
        });

        // Outputs
        StackUtils.exportStack(
            this,
            'DistributionDomainName',
            distribution.distributionDomainName,
            'CloudFront Domain Name',
        );
        StackUtils.exportStack(this, 'DistributionId', distribution.distributionId, 'CloudFront Distribution ID');
        StackUtils.exportStack(this, 'BucketName', websiteBucket.bucketName, 'Website content bucket');
    }
}
