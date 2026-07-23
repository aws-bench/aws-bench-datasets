import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: s3_s5wscsi4m
 *
 * The stack creates the following resources:
 *
 * 1. 1 S3 Bucket with React frontend files
 *
 */

export class s3_s5wscsi4m extends cdk.Stack {
    private readonly accountId: string;

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        this.accountId = this.account;

        // Create S3 bucket for frontend source
        const sourceBucket = new s3.Bucket(this, 'FrontendSourceBucket', {
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
        });
        sourceBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Deploy React frontend files to bucket (misaligned)
        const deployment = new s3deploy.BucketDeployment(this, 'DeployFrontend', {
            sources: [
                s3deploy.Source.data(
                    'src/index.html',
                    `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>React App</title>
    <link rel="stylesheet" href="assets/main.css">
</head>
<body>
    <div id="root"></div>
    <script src="build/app.bundle.js"></script>
</body>
</html>`,
                ),
                s3deploy.Source.data(
                    'styles/main.css',
                    `
body { font-family: Arial, sans-serif; margin: 0; padding: 20px; }
.container { max-width: 800px; margin: 0 auto; }
h1 { color: #333; }`,
                ),
                s3deploy.Source.data(
                    'scripts/app.js',
                    `
console.log('React App Loaded');
document.getElementById('root').innerHTML = '<h1>Hello React!</h1>';`,
                ),
            ],
            destinationBucket: sourceBucket,
        });

        // Export stack information
        StackUtils.exportStack(this, 'BucketName', sourceBucket.bucketName);
    }
}
