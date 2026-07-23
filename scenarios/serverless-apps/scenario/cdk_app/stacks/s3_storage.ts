import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { aws_s3, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { StackUtils } from '../lib/shared';

export class S3StorageStack extends cdk.Stack {

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // Create S3 buckets
        const iotDataBucket = new s3.Bucket(this, 'my-iot-data-archive', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            enforceSSL: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
        });

        const orderArchivesBucket = new s3.Bucket(this, 'orders-archive-bucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            enforceSSL: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
        });

        const lifecycleBucket = new s3.Bucket(this, 'lifecycle-bucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            enforceSSL: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            lifecycleRules: [
                {
                    tagFilters: { shouldDelete: 'true' },
                    id: 'orders-archive-bucket-lifecycle-rule',
                    enabled: true,
                    expiration: Duration.days(1),
                },
            ],
        });

        // Export S3 bucket names
        StackUtils.exportStack(this, 'IotDataBucketName', iotDataBucket.bucketName);
        StackUtils.exportStack(this, 'OrderArchivesBucketName', orderArchivesBucket.bucketName);
        StackUtils.exportStack(this, 'LifeCycleBucket', lifecycleBucket.bucketName);

        // Source bucket with a storage-class analytics configuration. Its data export
        // targets a bucket owned by a different AWS account (declared via BucketAccountId),
        // so the destination is intentionally NOT a bucket in this account.
        const analyticsExportDestinationAccountId = '111122223333';
        const analyticsExportDestinationArn = `arn:aws:s3:::business-analytics-destination-data-bucket-${analyticsExportDestinationAccountId}`;
        const analyticsBucketName = `business-analytics-source-data-bucket-${this.account}`;
        const analyticsBucket = new aws_s3.CfnBucket(this, analyticsBucketName, {
            bucketName: analyticsBucketName,
            publicAccessBlockConfiguration: {
                blockPublicPolicy: true,
                ignorePublicAcls: true,
                restrictPublicBuckets: true,
            },
            analyticsConfigurations: [
                {
                    id: 'testAnalyticsConfiguration',
                    storageClassAnalysis: {
                        dataExport: {
                            destination: {
                                bucketArn: analyticsExportDestinationArn,
                                bucketAccountId: analyticsExportDestinationAccountId,
                                format: 'CSV',
                            },
                            outputSchemaVersion: 'V_1', // The version of the output schema
                        },
                    },
                },
            ],
        });

        // Analytics Bucket Exports
        StackUtils.exportStack(this, 'AnalyticsBucketName', analyticsBucketName);

        // S3 bucket with website hosting enabled
        const websiteHostingBucket = new s3.Bucket(this, 'WebsiteHostingBucket', {
            websiteIndexDocument: 'index.html',
            publicReadAccess: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            autoDeleteObjects: true,
        });

        StackUtils.exportStack(
            this,
            'WebsiteHostingBucketName',
            websiteHostingBucket.bucketName,
            'Name of the S3 bucket with website hosting enabled',
        );

        // S3 bucket with inventory configuration
        const inventoryBucket = new s3.Bucket(this, 'InventoryBucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            autoDeleteObjects: true,
        });
        const inventoryDestinationBucket = new s3.Bucket(this, 'InventoryDestinationBucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            autoDeleteObjects: true,
        });

        inventoryBucket.addInventory({
            destination: {
                bucket: inventoryDestinationBucket,
            },
            frequency: s3.InventoryFrequency.DAILY,
            includeObjectVersions: s3.InventoryObjectVersion.CURRENT,
            objectsPrefix: 'inventory-data',
        });

        // Inventory Bucket Exports
        StackUtils.exportStack(this, 'InventoryBucketName', inventoryBucket.bucketName);

        // S3 bucket with metrics configuration
        const metricsBucket = new s3.Bucket(this, 'MetricsBucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            autoDeleteObjects: true,
        });
        metricsBucket.addMetric({
            id: 'EntireBucket',
        });
        metricsBucket.addMetric({
            id: 'ImportantPrefix',
            prefix: 'important/',
        });
        metricsBucket.addMetric({
            id: 'ImportantTag',
            tagFilters: { priority: 'high' },
        });

        StackUtils.exportStack(this, 'MetricsBucketName', metricsBucket.bucketName);
    }
}
