import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * CloudFront Functions Stack
 *
 * Converted from aws-cdk-examples/typescript/cloudfront-functions
 *
 * Creates:
 * 1. S3 Bucket for static website content
 * 2. CloudFront Origin Access Identity
 * 3. CloudFront Function for request modification (adds custom header)
 * 4. CloudFront Function for response modification (adds custom header)
 * 5. CloudFront Distribution with S3 origin and function associations
 */

export class CloudfrontFunctionsStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // S3 Bucket for website content
        const bucket = new s3.Bucket(this, 'WebsiteBucket', {
            bucketName: `cloudfront-functions-site-${this.account}-${this.region}`,
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
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
            Resource: [
                bucket.bucketArn,
                `${bucket.bucketArn}/*`,
            ],
        });

        // CloudFront Origin Access Identity
        const oai = new cloudfront.OriginAccessIdentity(this, 'OAI', {
            comment: `OAI for ${bucket.bucketName}`,
        });

        // Grant OAI read access on bucket
        bucket.grantRead(oai);

        // CloudFront Function - Request (viewer-request)
        const requestFunction = new cloudfront.Function(this, 'RequestFunction', {
            functionName: `request-function-${this.account}`,
            runtime: cloudfront.FunctionRuntime.JS_2_0,
            code: cloudfront.FunctionCode.fromFile({
                filePath: path.join(__dirname, '../../assets/cloudfront-request-function/index.js'),
            }),
            comment: 'Adds custom header to viewer requests',
        });

        // CloudFront Function - Response (viewer-response)
        const responseFunction = new cloudfront.Function(this, 'ResponseFunction', {
            functionName: `response-function-${this.account}`,
            runtime: cloudfront.FunctionRuntime.JS_2_0,
            code: cloudfront.FunctionCode.fromFile({
                filePath: path.join(__dirname, '../../assets/cloudfront-response-function/index.js'),
            }),
            comment: 'Adds custom header to viewer responses',
        });

        // CloudFront Distribution
        const distribution = new cloudfront.Distribution(this, 'Distribution', {
            defaultBehavior: {
                origin: new origins.S3Origin(bucket, {
                    originAccessIdentity: oai,
                }),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                functionAssociations: [
                    {
                        function: requestFunction,
                        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                    },
                    {
                        function: responseFunction,
                        eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE,
                    },
                ],
            },
            defaultRootObject: 'index.html',
        });

        // Exports
        StackUtils.exportStack(this, 'DistributionId', distribution.distributionId, 'CloudFront distribution ID');
        StackUtils.exportStack(this, 'DistributionDomainName', distribution.distributionDomainName, 'CloudFront distribution domain name');
        StackUtils.exportStack(this, 'BucketName', bucket.bucketName, 'S3 bucket name for website content');
        StackUtils.exportStack(this, 'BucketArn', bucket.bucketArn, 'S3 bucket ARN');
        StackUtils.exportStack(this, 'RequestFunctionName', requestFunction.functionName, 'CloudFront request function name');
        StackUtils.exportStack(this, 'ResponseFunctionName', responseFunction.functionName, 'CloudFront response function name');
        StackUtils.exportStack(this, 'OaiId', oai.originAccessIdentityId, 'CloudFront Origin Access Identity ID');
        StackUtils.exportStack(this, 'DefaultRootObject', 'index.html', 'Default root object for the distribution');
    }
}
