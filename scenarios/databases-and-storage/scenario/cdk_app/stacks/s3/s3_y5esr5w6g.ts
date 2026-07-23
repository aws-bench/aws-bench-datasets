import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 *
 * Stack ID: s3_y5esr5w6g
 *
 * What the stack does:
 * Creates a versioned S3 bucket with two objects uploaded at different times.
 * prod_data.txt is uploaded first via BucketDeployment.
 * archive_data.txt is uploaded ~60s later via a custom resource Lambda,
 * ensuring the two objects have distinct LastModified timestamps.
 *
 */

export class s3_y5esr5w6g extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const bucket = new s3.Bucket(this, 'bucket', {
            bucketName: `productionbucket-2hdb3j45-${this.account}-${this.region}`,
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
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

        // First object: uploaded immediately
        const firstUpload = new s3deploy.BucketDeployment(this, 'fileUpload', {
            sources: [s3deploy.Source.data('prod_data.txt', 'Production data for e-commerce system')],
            destinationBucket: bucket,
            retainOnDelete: false,
        });

        // Second object: uploaded after a delay via custom resource
        const delayedUploadFn = new lambda.Function(this, 'DelayedUploadFn', {
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            timeout: cdk.Duration.seconds(120),
            code: lambda.Code.fromInline(`
import boto3, time, json, urllib3
def send(event, context, status, data={}):
    urllib3.PoolManager().request('PUT', event['ResponseURL'], body=json.dumps({
        'Status': status, 'Reason': 'See CloudWatch', 'PhysicalResourceId': context.log_stream_name,
        'StackId': event['StackId'], 'RequestId': event['RequestId'], 'LogicalResourceId': event['LogicalResourceId'], 'Data': data
    }), headers={'Content-Type': ''})
def handler(event, context):
    try:
        if event['RequestType'] != 'Delete':
            bucket = event['ResourceProperties']['BucketName']
            time.sleep(5)
            boto3.client('s3').put_object(Bucket=bucket, Key='archive_data.txt', Body='Archived records from 2021 migration')
        send(event, context, 'SUCCESS')
    except Exception as e:
        send(event, context, 'FAILED')
`),
        });
        bucket.grantPut(delayedUploadFn);

        const delayedUpload = new cdk.CustomResource(this, 'DelayedUpload', {
            serviceToken: delayedUploadFn.functionArn,
            properties: {
                BucketName: bucket.bucketName,
            },
        });
        delayedUpload.node.addDependency(firstUpload);

        StackUtils.exportStack(this, 'BucketName', bucket.bucketName, 'The name of the S3 bucket');
    }
}
