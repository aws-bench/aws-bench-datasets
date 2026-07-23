import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: s3_eor38cdr9
 * What the stack does:
 * 1. Creates a Bucket.
 * 2. Adds sample file inside a directory
 */

export class s3_eor38cdr9 extends cdk.Stack {

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);


        const bucket = new s3.Bucket(this, 'Bucket', {
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
            // Intentionally non-standard public access block configuration:
            // BlockPublicAcls=false but other protections remain active
            blockPublicAccess: new s3.BlockPublicAccess({
                blockPublicAcls: false,
                ignorePublicAcls: true,
                blockPublicPolicy: true,
                restrictPublicBuckets: true,
            }),
            enforceSSL: true,
            bucketName: `order-bucket-wjw2h321-${this.account}-${this.region}`,
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
                bucket.bucketArn,
                `${bucket.bucketArn}/*`,
            ],
        });

        const subDir = 'documents/';
        new s3deploy.BucketDeployment(this, 'DeployFile', {
            sources: [s3deploy.Source.data(`${subDir}sample.txt`, 'Hello world!!.')],
            destinationBucket: bucket,
        });

        StackUtils.exportStack(this, 'BucketName', bucket.bucketName, 'S3 Bucket name');
        StackUtils.exportStack(this, 'SubDirectoryName', subDir, 'S3 bucket folder');
    }
}
