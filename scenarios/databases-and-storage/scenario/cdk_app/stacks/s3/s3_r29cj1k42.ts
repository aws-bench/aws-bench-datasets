import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: s3_r29cj1k42
 * What the stack does:
 1. The stack creates an S3 bucket to store CSV files
 2. The stack creates a bucket deployment to upload a CSV file
*/

export class s3_r29cj1k42 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // Create S3 bucket
        const bucket = new s3.Bucket(this, 'S3Bucket', {
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
        });

        // Define CSV content
        const productsData = `product_id,name,category,price,stock,description
        PROD001,Gaming Laptop,Electronics,1299.99,10,High-performance gaming laptop
        PROD002,Wireless Mouse,Electronics,29.99,50,Ergonomic wireless mouse
        PROD003,Coffee Maker,Appliances,79.99,25,Programmable coffee maker
        PROD004,Running Shoes,Sports,89.99,30,Professional running shoes
        PROD005,Backpack,Accessories,49.99,40,Water-resistant backpack`;

        const fileName = 'products.csv';

        // Deploy CSV data directly to S3
        new s3deploy.BucketDeployment(this, 'CSVFilesUpload', {
            destinationBucket: bucket,
            sources: [s3deploy.Source.data(fileName, productsData)],
        });

        StackUtils.exportStack(this, 'CsvBucketName', bucket.bucketName);
        StackUtils.exportStack(this, 'FileName', fileName);
    }
}
