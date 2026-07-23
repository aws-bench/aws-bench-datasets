import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: s3_etlcsv9q2
 *
 * Precondition for the quicksight-csv-to-excel-pipeline task.
 *
 * Resources:
 *  - One S3 bucket pre-loaded with three small CSV files under raw/.
 *    Filenames are predictable; the agent uploads converted .xlsx files to
 *    the configured output prefix.
 *
 * Outputs:
 *  - ETLBucketName    -- the bucket
 *  - SomeFolderName   -- the output prefix the agent must use ("converted/")
 *
 * The agent's job: write a Lambda that, on .csv create under raw/, writes
 * an Excel-format object to converted/. Verifier checks for one .xlsx per
 * input .csv plus a working S3 trigger configuration on the function.
 */
export class s3_etlcsv9q2 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const bucket = new s3.Bucket(this, 'EtlBucket', {
            bucketName: `etl-pipeline-${this.account}-${this.region}`,
            versioned: false,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
        });

        // Harden the autoDeleteObjects handler with identity-based S3 grants.
        // By default the handler role's ONLY S3 access is the grant the
        // bucket policy gives its exact role ARN. If that grant is stale or
        // gone at delete time, the handler fails its first call
        // (s3:GetBucketTagging) with AccessDenied, the stack delete
        // force-abandons this FIXED-NAME bucket, and every later deploy fails
        // changeset validation with "already exists" — an unrecoverable
        // reset->redeploy loop. Granting the role directly removes the
        // dependence on bucket-policy survival.
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

        // Three deterministic CSVs the verifier can list back.
        new s3deploy.BucketDeployment(this, 'SeedCsvs', {
            destinationBucket: bucket,
            destinationKeyPrefix: 'raw/',
            sources: [
                s3deploy.Source.data(
                    'orders_2026_01.csv',
                    'order_id,customer_id,total\n1,42,99.95\n2,17,12.50\n3,99,7.25\n',
                ),
                s3deploy.Source.data(
                    'orders_2026_02.csv',
                    'order_id,customer_id,total\n4,42,42.00\n5,17,18.99\n',
                ),
                s3deploy.Source.data(
                    'orders_2026_03.csv',
                    'order_id,customer_id,total\n6,99,1.99\n7,42,250.00\n8,17,8.49\n',
                ),
            ],
        });

        StackUtils.exportStack(this, 'ETLBucketName', bucket.bucketName, 'Source CSV bucket');
        // Stable output prefix the agent reads from instruction text. Trailing
        // slash convention preserved so verifier can prefix-match cleanly.
        StackUtils.exportStack(this, 'SomeFolderName', 'converted/', 'Output folder for .xlsx');
    }
}
