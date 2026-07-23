import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
* Stack ID: dynamodb_tk2o3jasd

* What the stack does:
1. Creates a DynamoDB table with tag and ResolvedAt attributes,
2. Populates the table with sample data containing empty tag strings and non-zero ResolvedAt values,
3. Queries and displays the count of records matching the criteria.
*/

export class dynamodb_tk2o3jasd extends cdk.Stack {
    private readonly accountId: string | undefined;
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);


        // Create DynamoDB table with tag and ResolvedAt attributes
        const table = new dynamodb.Table(this, 'DynamoDBTable', {
            tableName: `dynamodb-yhe1we-${this.account}-${this.region}`,
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Custom resource to populate table with sample data
        const populateData = new cr.AwsCustomResource(this, 'PopulateData', {
            onCreate: {
                service: 'DynamoDB',
                action: 'batchWriteItem',
                parameters: {
                    RequestItems: {
                        [table.tableName]: [
                            {
                                PutRequest: {
                                    Item: {
                                        id: { S: 'item1' },
                                        tag: { S: '' },
                                        ResolvedAt: { N: '1640995200' },
                                    },
                                },
                            },
                            {
                                PutRequest: {
                                    Item: {
                                        id: { S: 'item2' },
                                        tag: { S: '' },
                                        ResolvedAt: { N: '1672531200' },
                                    },
                                },
                            },
                            {
                                PutRequest: {
                                    Item: {
                                        id: { S: 'item3' },
                                        tag: { S: 'active' },
                                        ResolvedAt: { N: '0' },
                                    },
                                },
                            },
                        ],
                    },
                },
                physicalResourceId: cr.PhysicalResourceId.of('data-population'),
            },
            policy: cr.AwsCustomResourcePolicy.fromStatements([
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['dynamodb:BatchWriteItem'],
                    resources: [table.tableArn],
                }),
            ]),
        });

        // Custom resource to query and count records
        const countQuery = new cr.AwsCustomResource(this, 'CountQuery', {
            onCreate: {
                service: 'DynamoDB',
                action: 'scan',
                parameters: {
                    TableName: table.tableName,
                    FilterExpression: 'tag = :empty_tag AND ResolvedAt > :zero',
                    ExpressionAttributeValues: {
                        ':empty_tag': { S: '' },
                        ':zero': { N: '0' },
                    },
                    Select: 'COUNT',
                },
                physicalResourceId: cr.PhysicalResourceId.of('count-query'),
            },
            policy: cr.AwsCustomResourcePolicy.fromStatements([
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['dynamodb:Scan'],
                    resources: [table.tableArn],
                }),
            ]),
        });

        // Make sure count query runs after data population
        countQuery.node.addDependency(populateData);

        StackUtils.exportStack(this, 'TableName', table.tableName, 'DynamoDB table name');
        StackUtils.exportStack(
            this,
            'RecordCount',
            countQuery.getResponseField('Count'),
            'Count of records with empty tag and ResolvedAt > 0',
        );
    }
}
