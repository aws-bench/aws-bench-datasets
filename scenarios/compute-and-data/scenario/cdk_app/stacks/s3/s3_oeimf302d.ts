import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: s3_oeimf302d
 * What the stack does:
 * 1. Creates a S3 bucket with 2 folders
 */

export class s3_oeimf302d extends cdk.Stack {
    private readonly accountId: string;

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        this.accountId = this.account;

        const bucket = new s3.Bucket(this, 'MyBucket', {
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            bucketName: `test-bucket-${this.accountId}-${this.region}`,
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

        // Create source folder with sample objects
        new s3deploy.BucketDeployment(this, 'SourceFolderDeployment', {
            sources: [
                s3deploy.Source.data('source/file1.txt', 'Sample content 1'),
                s3deploy.Source.data('source/file2.json', '{"key": "value"}'),
                s3deploy.Source.data('source/subfolder/file3.txt', 'Nested content'),
            ],
            destinationBucket: bucket,
        });

        // Create destination folder with placeholder
        new s3deploy.BucketDeployment(this, 'DestinationFolderDeployment', {
            sources: [s3deploy.Source.data('destination/placeholder.txt', 'Ready')],
            destinationBucket: bucket,
        });

        StackUtils.exportStack(
            this,
            'WrongBucketName',
            `test-buckets-${this.accountId}-${this.region}`,
            'Wrong S3 bucket Name',
        );
        StackUtils.exportStack(this, 'WrongSourceFolderPath', 'sourc/', 'Wrong Source folder');
        StackUtils.exportStack(this, 'BucketName', bucket.bucketName, 'S3 bucket Name');
        StackUtils.exportStack(this, 'SourceFolderPath', 'source/', 'Source folder');
        StackUtils.exportStack(this, 'DestinationFolderPath', 'destination/', 'Destination folder');
    }
}
