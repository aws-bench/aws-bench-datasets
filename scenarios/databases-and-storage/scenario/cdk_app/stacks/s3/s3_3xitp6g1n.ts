import * as cdk from 'aws-cdk-lib';
import * as s3tables from 'aws-cdk-lib/aws-s3tables';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: s3_3xitp6g1n
 *
 * The stack creates the following resources:
 *
 * 1. 1 S3 Table Bucket
 * 2. 1 IAM policy for table bucket access
 *
 */

export class s3_3xitp6g1n extends cdk.Stack {
    private readonly accountId: string;
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);
        this.accountId = this.account;

        // S3 Table Bucket
        const tableBucket = new s3tables.CfnTableBucket(this, 'TableBucket', {
            tableBucketName: `table-bucket-2o4yh4-${this.accountId}-${this.region}`,
        });
        tableBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // IAM Policy for S3 Tables
        const tablePolicy = new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.AccountRootPrincipal()],
            actions: ['s3tables:GetTable', 's3tables:ListTables', 's3tables:CreateTable', 's3tables:DeleteTable'],
            resources: [tableBucket.attrTableBucketArn, `${tableBucket.attrTableBucketArn}/*`],
        });

        // Export stack information
        StackUtils.exportStack(this, 'TableBucketName', tableBucket.tableBucketName);
        StackUtils.exportStack(this, 'TableBucketArn', tableBucket.attrTableBucketArn);
    }
}
