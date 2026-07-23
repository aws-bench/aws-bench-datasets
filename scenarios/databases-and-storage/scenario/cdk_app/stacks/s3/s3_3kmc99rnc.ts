import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: s3_3kmc99rnc
 * What the stack does:
 * 1. Creates two Buckets for comparison.
 * 2. Adds different files and structures to each bucket
 */

export class s3_3kmc99rnc extends cdk.Stack {

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);


        // First bucket with documents
        const bucket1 = new s3.Bucket(this, 'Bucket1', {
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            bucketName: `product-bucket-1hg32ja-${this.account}-${this.region}`,
        });

        const subDir1 = 'mydocuments/';
        new s3deploy.BucketDeployment(this, 'DeployFiles1', {
            sources: [s3deploy.Source.data(`${subDir1}sample.txt`, 'Hello world!!.')],
            destinationBucket: bucket1,
        });

        // Second bucket with different structure
        const bucket2 = new s3.Bucket(this, 'Bucket2', {
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            bucketName: `sample99-bucket-2321hdbeyui-${this.account}-${this.region}`,
        });

        // Harden the autoDeleteObjects handler with identity-based S3 grants.
        // By default the handler role's ONLY S3 access is the grant each bucket
        // policy gives its exact role ARN. If that grant is stale or gone at
        // delete time, the handler fails its first call (s3:GetBucketTagging)
        // with AccessDenied, the stack delete force-abandons these FIXED-NAME
        // buckets, and every later deploy fails changeset validation with
        // "already exists" — an unrecoverable reset->redeploy loop. Granting
        // the role directly removes the dependence on bucket-policy survival.
        // One block covers every fixed-name autoDeleteObjects bucket in the stack.
        const autoDeleteProvider = this.node.tryFindChild(
            'Custom::S3AutoDeleteObjectsCustomResourceProvider',
        ) as cdk.CustomResourceProviderBase | undefined;
        autoDeleteProvider?.addToRolePolicy({
            Effect: 'Allow',
            Action: ['s3:GetBucket*', 's3:List*', 's3:DeleteObject*', 's3:PutBucketPolicy'],
            Resource: [
                bucket1.bucketArn,
                `${bucket1.bucketArn}/*`,
                bucket2.bucketArn,
                `${bucket2.bucketArn}/*`,
            ],
        });

        const subDir2 = 'yourdocuments/';
        new s3deploy.BucketDeployment(this, 'DeployFiles2', {
            sources: [s3deploy.Source.data(`${subDir2}sample.txt`, 'Hello world!!.')],
            destinationBucket: bucket2,
        });

        StackUtils.exportStack(this, 'Bucket1Name', bucket1.bucketName, 'First S3 Bucket name');
        StackUtils.exportStack(this, 'Bucket2Name', bucket2.bucketName, 'Second S3 Bucket name');
        StackUtils.exportStack(this, 'SubDirectory1Name', subDir1, 'S3 bucket folder');
        StackUtils.exportStack(this, 'SubDirectory2Name', subDir2, 'S3 bucket folder');
    }
}
