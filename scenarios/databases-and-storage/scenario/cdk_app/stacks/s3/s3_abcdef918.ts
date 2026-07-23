import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: s3_abcdef918
 * What the stack does:
 * 1. Creates 3 empty buckets
 * 2. Creates 1 buckets with content
 *
 * */
export class s3_abcdef918 extends cdk.Stack {
    private readonly accountId: string | undefined;
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);


        // Create 3 empty buckets
        const emptyBucket1 = new s3.Bucket(this, 'FirstEmptyBucket', {
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
        });

        const emptyBucket2 = new s3.Bucket(this, 'SecondEmptyBucket', {
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
        });

        const emptyBucket3 = new s3.Bucket(this, 'ThirdEmptyBucket', {
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
        });

        // Create a bucket with a text file
        const bucketWithFile = new s3.Bucket(this, 'BucketWithSomeFile', {
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
        });

        // Deploy text file to the bucket using s3.deploy method
        new s3deploy.BucketDeployment(this, 'DeployFile', {
            sources: [s3deploy.Source.data('samplefile.txt', 'Hello, this is a sample text file!')],
            destinationBucket: bucketWithFile,
        });

        // Output the bucket names
        StackUtils.exportStack(this, 'BucketWithFile', bucketWithFile.bucketName, 'Bucket that having content');
        StackUtils.exportStack(this, 'EmptyBucket1', emptyBucket1.bucketName, 'Bucket Name');
        StackUtils.exportStack(this, 'EmptyBucket2', emptyBucket2.bucketName, 'Bucket Name');
        StackUtils.exportStack(this, 'EmptyBucket3', emptyBucket3.bucketName, 'Bucket Name');
    }
}
