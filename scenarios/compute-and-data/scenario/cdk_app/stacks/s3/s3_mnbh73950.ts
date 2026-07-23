import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: s3_mnbh73950
 * What the stack does:
 1. The stack creates a source S3 bucket
 2. The stack creates a destination S3 bucket
 3. The stack creates a bucket deployment to upload a file to the source bucket
*/
export class s3_mnbh73950 extends cdk.Stack {
    private readonly accountId: string;

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        this.accountId = this.account;

        // Create first S3 bucket
        const sourceBucket = new s3.Bucket(this, 'SourceBucket', {
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            enforceSSL: true,
        });

        // Create second S3 bucket
        const destinationBucket = new s3.Bucket(this, 'DestinationBucket', {
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            enforceSSL: true,
        });

        // Upload a file to S3 bucket
        new s3deploy.BucketDeployment(this, 'BucketDeployment', {
            sources: [s3deploy.Source.data('sample.txt', 'This is a sample text file content.\nCreated using CDK!')],
            destinationBucket: sourceBucket,
        });

        // Create CloudFormation outputs

        StackUtils.exportStack(this, 'SourceBucketName', sourceBucket.bucketName);
        StackUtils.exportStack(this, 'SourceBucketArn', sourceBucket.bucketArn);
        StackUtils.exportStack(this, 'DestinationBucketName', destinationBucket.bucketName);
        StackUtils.exportStack(this, 'DestinationBucketArn', destinationBucket.bucketArn);
    }
}
