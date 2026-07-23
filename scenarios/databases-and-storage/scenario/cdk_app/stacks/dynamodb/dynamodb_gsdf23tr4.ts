import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: dynamodb_gsdf23tr4
 * What the stack does:
 * 1. Creates DynamoDB table with specific attributes
 * 2. Populates table with sample items using AWS SDK custom resource
 */

export class dynamodb_gsdf23tr4 extends cdk.Stack {
    private readonly accountId: string | undefined;
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);


        // DynamoDB table with specific attributes
        const table = new dynamodb.Table(this, 'ItemsTable', {
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            tableName: `prod-table-2h3g4j-${this.account}-${this.region}`,
        });

        // Define attribute names
        const attributeNames = 'status';

        // Populate items using AWS SDK custom resource
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
                status: { S: 'active' },
                category: { S: 'premium' },
                score: { N: '88' },
                name: { S: 'Bob Wilson' },
                email: { S: 'bob@example.com' },
            },
            {
                id: { S: 'website-001' },
                timestamp: { N: '1700000003' },
                category: { S: 'websites' },
                score: { N: '70' },
                name: { S: 'website1.com' },
            },
            {
                id: { S: 'website-002' },
                timestamp: { N: '1700000004' },
                category: { S: 'websites' },
                score: { N: '50' },
                name: { S: 'website2.com' },
            },
            {
                id: { S: 'website-003' },
                timestamp: { N: '1700000005' },
                category: { S: 'websites' },
                score: { N: '72' },
                name: { S: 'website3.com' },
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

        StackUtils.exportStack(this, 'TableName', table.tableName, 'The DynamoDB table name');
        StackUtils.exportStack(this, 'AttributeNames', attributeNames, 'The DynamoDB table attribute names');
    }
}
