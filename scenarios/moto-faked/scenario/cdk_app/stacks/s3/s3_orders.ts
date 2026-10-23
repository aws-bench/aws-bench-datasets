import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
* Stack ID: s3-orders
*
* What the stack does:
* 1. Creates the order-intake landing bucket (versioned, SSL-enforced).
* Order batches land under the `incoming/` prefix; nothing else in this
* scenario writes to the bucket, so verifiers can assert exact contents.
*
* Moto note: no autoDeleteObjects / custom resources — moto's
* CloudFormation cannot execute Lambda-backed custom resources, so this
* stack uses only AWS::S3::Bucket.
*/

export class S3Orders extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const landing = new s3.Bucket(this, 'LandingBucket', {
            versioned: true,
            enforceSSL: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        StackUtils.exportStack(this, 'LandingBucketName', landing.bucketName, 'Order-intake landing bucket');
        StackUtils.exportStack(this, 'LandingBucketArn', landing.bucketArn, 'ARN of the landing bucket');
    }
}
