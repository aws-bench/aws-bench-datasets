import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as custom from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
* Stack ID: dynamodb_adhk146bg

* 1. Creates an S3 bucket for DynamoDB exports
* 2. Creates 4 DynamoDB tables with point-in-time recovery
* 3. Adds bucket policy for DynamoDB export
* 4. Grants DynamoDB export permissions to all tables
* */

export class dynamodb_adhk146bg extends cdk.Stack {
    private readonly accountId: string;

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        this.accountId = this.account;

        // Create S3 bucket
        const exportBucket = new s3.Bucket(this, 'S3ExportBucket', {
            bucketName: `ddb-export-${this.accountId}-${cdk.Stack.of(this).region}`,
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
        });
        exportBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

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
                exportBucket.bucketArn,
                `${exportBucket.bucketArn}/*`,
            ],
        });

        // Create Users Table
        const usersTable = new dynamodb.Table(this, 'UsersTable', {
            tableName: 'users',
            partitionKey: {
                name: 'id',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            pointInTimeRecovery: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        usersTable.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Create Products Table
        const productsTable = new dynamodb.Table(this, 'ProductsTable', {
            tableName: 'products',
            partitionKey: {
                name: 'id',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            pointInTimeRecovery: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Create Orders Table
        const ordersTable = new dynamodb.Table(this, 'OrdersTable', {
            tableName: 'orders',
            partitionKey: {
                name: 'id',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            pointInTimeRecovery: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Create Inventory Table
        const inventoryTable = new dynamodb.Table(this, 'InventoryTable', {
            tableName: 'inventory',
            partitionKey: {
                name: 'id',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            pointInTimeRecovery: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Add initial data to all tables in a single batchWriteItem call
        new custom.AwsCustomResource(this, 'AllTablesInitialData', {
            onCreate: {
                service: 'DynamoDB',
                action: 'batchWriteItem',
                parameters: {
                    RequestItems: {
                        [usersTable.tableName]: [
                            {
                                PutRequest: {
                                    Item: {
                                        id: { S: 'user_1' },
                                        name: { S: 'User Record 1' },
                                        createdAt: { S: new Date().toISOString() },
                                    },
                                },
                            },
                            {
                                PutRequest: {
                                    Item: {
                                        id: { S: 'user_2' },
                                        name: { S: 'User Record 2' },
                                        createdAt: { S: new Date().toISOString() },
                                    },
                                },
                            },
                        ],
                        [productsTable.tableName]: [
                            {
                                PutRequest: {
                                    Item: {
                                        id: { S: 'product_1' },
                                        name: { S: 'Product Record 1' },
                                        createdAt: { S: new Date().toISOString() },
                                    },
                                },
                            },
                            {
                                PutRequest: {
                                    Item: {
                                        id: { S: 'product_2' },
                                        name: { S: 'Product Record 2' },
                                        createdAt: { S: new Date().toISOString() },
                                    },
                                },
                            },
                        ],
                        [ordersTable.tableName]: [
                            {
                                PutRequest: {
                                    Item: {
                                        id: { S: 'order_1' },
                                        name: { S: 'Order Record 1' },
                                        createdAt: { S: new Date().toISOString() },
                                    },
                                },
                            },
                            {
                                PutRequest: {
                                    Item: {
                                        id: { S: 'order_2' },
                                        name: { S: 'Order Record 2' },
                                        createdAt: { S: new Date().toISOString() },
                                    },
                                },
                            },
                        ],
                        [inventoryTable.tableName]: [
                            {
                                PutRequest: {
                                    Item: {
                                        id: { S: 'inventory_1' },
                                        name: { S: 'Inventory Record 1' },
                                        createdAt: { S: new Date().toISOString() },
                                    },
                                },
                            },
                            {
                                PutRequest: {
                                    Item: {
                                        id: { S: 'inventory_2' },
                                        name: { S: 'Inventory Record 2' },
                                        createdAt: { S: new Date().toISOString() },
                                    },
                                },
                            },
                        ],
                    },
                },
                physicalResourceId: custom.PhysicalResourceId.of('AllTablesInitialData'),
            },
            policy: custom.AwsCustomResourcePolicy.fromSdkCalls({
                resources: [
                    usersTable.tableArn,
                    productsTable.tableArn,
                    ordersTable.tableArn,
                    inventoryTable.tableArn,
                ],
            }),
        });

        // Deploy simulated DynamoDB export data to S3
        new s3deploy.BucketDeployment(this, 'ExportDataDeployment', {
            sources: [
                // exports/orders/ - 9 objects, ~1.9 KiB
                s3deploy.Source.jsonData('exports/orders/manifest-summary.json', {
                    version: '2020-06-30',
                    exportArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/orders/export/01234567890123-abcdef',
                    exportTime: '2024-01-15T10:00:00.000Z',
                    tableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/orders',
                    tableId: 'abcd1234-5678-90ab-cdef-1234567890ab',
                    billingMode: 'PAY_PER_REQUEST',
                    itemCount: 2,
                    outputFormat: 'DYNAMODB_JSON',
                }),
                s3deploy.Source.jsonData('exports/orders/manifest-files.json', {
                    dataFileS3Key: 'exports/orders/data/',
                    manifestFilesS3Key: 'exports/orders/',
                }),
                s3deploy.Source.data(
                    'exports/orders/data/item-0001.json.gz',
                    '{"id":{"S":"order_1"},"name":{"S":"Order 1"}}',
                ),
                s3deploy.Source.data(
                    'exports/orders/data/item-0002.json.gz',
                    '{"id":{"S":"order_2"},"name":{"S":"Order 2"}}',
                ),
                s3deploy.Source.data('exports/orders/_started', ''),
                // exports/users/ - 9 objects
                s3deploy.Source.jsonData('exports/users/manifest-summary.json', {
                    version: '2020-06-30',
                    tableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/users',
                }),
                s3deploy.Source.data('exports/users/data/item-0001.json.gz', '{"id":{"S":"user_1"}}'),
                s3deploy.Source.data('exports/users/data/item-0002.json.gz', '{"id":{"S":"user_2"}}'),
                s3deploy.Source.data('exports/users/_started', ''),
                // exports/products/ - 9 objects
                s3deploy.Source.jsonData('exports/products/manifest-summary.json', {
                    version: '2020-06-30',
                    tableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/products',
                }),
                s3deploy.Source.data('exports/products/data/item-0001.json.gz', '{"id":{"S":"product_1"}}'),
                s3deploy.Source.data('exports/products/data/item-0002.json.gz', '{"id":{"S":"product_2"}}'),
                s3deploy.Source.data('exports/products/_started', ''),
                // exports/inventory/ - 9 objects
                s3deploy.Source.jsonData('exports/inventory/manifest-summary.json', {
                    version: '2020-06-30',
                    tableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/inventory',
                }),
                s3deploy.Source.data('exports/inventory/data/item-0001.json.gz', '{"id":{"S":"inventory_1"}}'),
                s3deploy.Source.data('exports/inventory/data/item-0002.json.gz', '{"id":{"S":"inventory_2"}}'),
                s3deploy.Source.data('exports/inventory/_started', ''),
            ],
            destinationBucket: exportBucket,
            prune: false,
        });

        // Add bucket policy for DynamoDB export
        exportBucket.addToResourcePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    's3:PutObject',
                    's3:GetObject',
                    's3:AbortMultipartUpload',
                    's3:ListMultipartUploadParts',
                    's3:ListBucket',
                ],
                principals: [new iam.ServicePrincipal('dynamodb.amazonaws.com')],
                resources: [exportBucket.arnForObjects('*'), exportBucket.bucketArn],
            }),
        );

        const path = 'exports/orders/';
        // Outputs
        StackUtils.exportStack(this, 'UsersTableName', usersTable.tableName, 'Users Table Name');
        StackUtils.exportStack(this, 'ProductsTableName', productsTable.tableName, 'Products Table Name');
        StackUtils.exportStack(this, 'OrdersTableName', ordersTable.tableName, 'Orders Table Name');
        StackUtils.exportStack(this, 'InventoryTableName', inventoryTable.tableName, 'Inventory Table Name');
        StackUtils.exportStack(this, 'BucketName', exportBucket.bucketName, 'Export Bucket Name');
        StackUtils.exportStack(this, 'Path', path, 'Export path Name');
    }
}
