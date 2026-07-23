import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { RemovalPolicy } from 'aws-cdk-lib';
import { StackUtils } from '../../lib/shared';
import * as cdk from 'aws-cdk-lib';

/*
 * Stack ID: s3_8hdgte56j
 * What the stack does:
 * 1. Creates a S3 bucket
 * 2. Creates IAM users
 * 3. Creates access keys for the users
 * */

export class s3_8hdgte56j extends cdk.Stack {

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);


        // S3 bucket
        const bucket = new s3.Bucket(this, 'Bucket', {
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: RemovalPolicy.DESTROY,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
        });

        const content = {
            message: 'Profile access test file',
            timestamp: new Date().toISOString(),
            testData: { id: 1, status: 'active' },
        };

        // Deploy file to bucket
        new s3deploy.BucketDeployment(this, 'DeployFile', {
            sources: [s3deploy.Source.jsonData('test-data.json', content)],
            destinationBucket: bucket,
        });

        // IAM users
        const devProfileUser = new iam.User(this, 'DevProfileUser', {
            userName: `dev-profile-test-user-${this.account}${this.region}`,
        });
        devProfileUser.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const stagingProfileUser = new iam.User(this, 'StagingProfileUser', {
            userName: `staging-profile-test-user${this.account}${this.region}`,
        });
        stagingProfileUser.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // Create access keys with no permissions granted to bucket
        new iam.AccessKey(this, 'DevProfileAccessKey', {
            user: devProfileUser,
        });

        new iam.AccessKey(this, 'StagingProfileAccessKey', {
            user: stagingProfileUser,
        });

        // Grant DevProfileUser read access via bucket policy
        // (not via identity policy — agent must check bucket policy too)
        bucket.addToResourcePolicy(new iam.PolicyStatement({
            sid: 'AllowDevProfileRead',
            effect: iam.Effect.ALLOW,
            principals: [new iam.ArnPrincipal(devProfileUser.userArn)],
            actions: ['s3:GetObject', 's3:ListBucket'],
            resources: [bucket.bucketArn, bucket.arnForObjects('*')],
        }));

        // Outputs
        StackUtils.exportStack(this, 'BucketName', bucket.bucketName, 'Bucket Name');
        StackUtils.exportStack(this, 'DevProfileUserName', devProfileUser.userName, 'Dev Profile Username');
        StackUtils.exportStack(this, 'StagingProfileUserName', stagingProfileUser.userName, 'Staging Profile Username');
        StackUtils.exportStack(this, 'Content', JSON.stringify(content), 'Content of the file inside S3 bucket');
    }
}
