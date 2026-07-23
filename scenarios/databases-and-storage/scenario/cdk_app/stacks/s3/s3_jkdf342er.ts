import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: s3_jkdf342er
 * What the stack does:
 * 1. Creates a S3 bucket.
 *
 * */

export class s3_jkdf342er extends cdk.Stack {
    private readonly accountId: string | undefined;
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);


        const bucket = new s3.Bucket(this, 'Bucket', {
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: cdk.aws_s3.BucketEncryption.KMS_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            bucketName: `prod-bucket-jdn294ng4-${this.account}-${this.region}`,
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

        const objectname = 'sample.csv';

        new s3deploy.BucketDeployment(this, 'DeployFile', {
            sources: [
                s3deploy.Source.data(objectname, 'Name,Age,City\nJohn,25,New York\nJane,30,London\nBob,35,Paris'),
            ],
            destinationBucket: bucket,
        });

        StackUtils.exportStack(this, 'BucketName', bucket.bucketName, 'The S3 Bucket name');
        StackUtils.exportStack(this, 'ObjectName', objectname, 'The S3 object name');
    }
}
