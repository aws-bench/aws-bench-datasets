import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: dynamodb_kdf231sdf
 * What the stack does:
 * 1. Creates DynamoDB table with records having various statuses
 */

export class dynamodb_kdf231sdf extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);


        // DynamoDB table
        const table = new dynamodb.Table(this, 'ItemsTable', {
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            tableName: `prod-table-ght34uh-${this.account}-${this.region}`,
        });

        // Sample items with various statuses
        const items = [
            {
                id: { S: 'user-001' },
                timestamp: { N: '1700000000' },
                status: { S: 'active' },
                category: { S: 'premium' },
                score: { N: '95' },
                name: { S: 'John Doe' },
                email: { S: 'john@example.com' },
            },
            {
                id: { S: 'user-002' },
                timestamp: { N: '1700000001' },
                status: { S: 'inactive' },
                category: { S: 'basic' },
                score: { N: '67' },
                name: { S: 'Jane Smith' },
                email: { S: 'jane@example.com' },
            },
            {
                id: { S: 'user-003' },
                timestamp: { N: '1700000002' },
                status: { S: 'pending' },
                category: { S: 'standard' },
                score: { N: '78' },
                name: { S: 'Bob Wilson' },
                email: { S: 'bob@example.com' },
            },
            {
                id: { S: 'user-004' },
                timestamp: { N: '1700000003' },
                status: { S: 'suspended' },
                category: { S: 'basic' },
                score: { N: '45' },
                name: { S: 'Alice Brown' },
                email: { S: 'alice@example.com' },
            },
            {
                id: { S: 'user-005' },
                timestamp: { N: '1700000004' },
                status: { S: 'active' },
                category: { S: 'premium' },
                score: { N: '92' },
                name: { S: 'Charlie Davis' },
                email: { S: 'charlie@example.com' },
            },
        ];

        // Populate items using a single batchWriteItem call
        new cr.AwsCustomResource(this, 'PopulateItems', {
            onCreate: {
                service: 'DynamoDB',
                action: 'batchWriteItem',
                parameters: {
                    RequestItems: {
                        [table.tableName]: items.map((item) => ({
                            PutRequest: { Item: item },
                        })),
                    },
                },
                physicalResourceId: cr.PhysicalResourceId.of('populate-items'),
            },
            policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
                resources: [table.tableArn],
            }),
        });

        // Output table name
        StackUtils.exportStack(this, 'TableName', table.tableName, 'The DynamoDB table name');
    }
}
