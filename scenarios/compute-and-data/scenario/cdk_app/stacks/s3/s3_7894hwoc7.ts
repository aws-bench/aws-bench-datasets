import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: s3_7894hwoc7
 * What the stack does:
 1. The stack creates an S3 bucket to store CSV files
 2. The stack creates a bucket deployment to upload CSV files
*/

export class s3_7894hwoc7 extends cdk.Stack {
    private readonly accountId: string;
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);
        this.accountId = this.account;

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
        const ordersData = `order_id,customer_id,order_date,total_amount,status
ORD001,CUST001,2024-01-15,199.99,completed
ORD002,CUST002,2024-01-16,349.50,processing
ORD003,CUST001,2024-01-17,89.99,completed
ORD004,CUST003,2024-01-17,459.98,pending
ORD005,CUST002,2024-01-18,129.99,completed`;

        const productsData = `product_id,name,category,price,stock,description
PROD001,Gaming Laptop,Electronics,1299.99,10,High-performance gaming laptop
PROD002,Wireless Mouse,Electronics,29.99,50,Ergonomic wireless mouse
PROD003,Coffee Maker,Appliances,79.99,25,Programmable coffee maker
PROD004,Running Shoes,Sports,89.99,30,Professional running shoes
PROD005,Backpack,Accessories,49.99,40,Water-resistant backpack`;

        const customersData = `customer_id,email,name,address,phone
CUST001,john.doe@email.com,John Doe,123 Main St,555-0101
CUST002,jane.smith@email.com,Jane Smith,456 Oak Ave,555-0102
CUST003,bob.wilson@email.com,Bob Wilson,789 Pine Rd,555-0103
CUST004,alice.brown@email.com,Alice Brown,321 Elm St,555-0104
CUST005,charlie.davis@email.com,Charlie Davis,654 Maple Dr,555-0105`;

        const orderItemsData = `order_id,product_id,quantity,price
ORD001,PROD002,2,29.99
ORD001,PROD005,1,49.99
ORD002,PROD001,1,1299.99
ORD003,PROD003,1,79.99
ORD004,PROD004,2,89.99
ORD005,PROD002,1,29.99`;

        const inventoryData = `product_id,warehouse_id,quantity,location
PROD001,WH001,5,Section A1
PROD001,WH002,5,Section B2
PROD002,WH001,25,Section A2
PROD002,WH002,25,Section B3
PROD003,WH001,15,Section A3
PROD003,WH002,10,Section B4
PROD004,WH001,20,Section A4
PROD004,WH002,10,Section B5
PROD005,WH001,20,Section A5
PROD005,WH002,20,Section B6`;

        // Deploy CSV data directly to S3
        new s3deploy.BucketDeployment(this, 'CSVFilesUpload', {
            destinationBucket: bucket,
            sources: [
                s3deploy.Source.data('orders.csv', ordersData),
                s3deploy.Source.data('products.csv', productsData),
                s3deploy.Source.data('customers.csv', customersData),
                s3deploy.Source.data('order_items.csv', orderItemsData),
                s3deploy.Source.data('inventory.csv', inventoryData),
            ],
        });

        StackUtils.exportStack(this, 'CsvBucketName', bucket.bucketName);
    }
}
