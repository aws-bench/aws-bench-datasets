import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';
import * as logs from 'aws-cdk-lib/aws-logs';

/*
 * Stack ID: dynamodb_ge54tw65t
 *
 * What the stack does:
 * The stack creates a DynamoDB table for storing web summary data.
 * The stack creates a Lambda function to query and process the data.
 * The stack creates an API Gateway to expose the query endpoints.
 * The stack creates a custom resource to populate initial data.
 */

export class dynamodb_ge54tw65t extends cdk.Stack {
    private readonly accountId: string | undefined;
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);


        const table = new dynamodb.Table(this, 'table', {
            tableName: `WebSummaryData`,
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        table.addGlobalSecondaryIndex({
            indexName: 'WorkflowIndex',
            partitionKey: { name: 'workflowId', type: dynamodb.AttributeType.STRING },
        });

        table.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        const queryLambdaLogGroup = new logs.LogGroup(this, 'QueryLambdaLogGroup', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const queryLambda = new lambda.Function(this, 'QueryLambda', {
            logGroup: queryLambdaLogGroup,
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'index.handler',
            code: lambda.Code.fromInline(`
                const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
                const client = new DynamoDBClient();
 
                exports.handler = async (event) => {
                const path = event.path;
                const tableName = process.env.TABLE_NAME;
                if (path === '/samples') {
                    const result = await client.send(new ScanCommand({ TableName: tableName, Limit: 3 }));
                    return { statusCode: 200, body: JSON.stringify(result.Items) };
                }
                if (path === '/count') {
                const result = await client.send(new ScanCommand({
                TableName: tableName,
                FilterExpression: '#status = :status',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':status': { S: 'completed' } },
                Select: 'COUNT'
                }));
                return { statusCode: 200, body: JSON.stringify({ count: result.Count }) };
                }
                if (path === '/workflows') {
                    const result = await client.send(new ScanCommand({
                    TableName: tableName,
                    ProjectionExpression: 'workflowId'
                }));
                const workflows = [...new Set(result.Items.map(item => item.workflowId.S))];
                return { statusCode: 200, body: JSON.stringify({ workflows }) };
                }
                return { statusCode: 404, body: 'Not found' };
            };`),
            environment: { TABLE_NAME: table.tableName },
        });

        table.grantReadData(queryLambda);

        queryLambda.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        const api = new apigateway.RestApi(this, 'WebSummaryApi', {
            restApiName: `WebSummaryApi-${this.account}-${this.region}`,
        });

        api.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        const integration = new apigateway.LambdaIntegration(queryLambda);
        api.root.addResource('samples').addMethod('GET', integration);
        api.root.addResource('count').addMethod('GET', integration);
        api.root.addResource('workflows').addMethod('GET', integration);

        new cr.AwsCustomResource(this, 'PopulateData', {
            onCreate: {
                service: 'DynamoDB',
                action: 'batchWriteItem',
                parameters: {
                    RequestItems: {
                        [table.tableName]: [
                            {
                                PutRequest: {
                                    Item: {
                                        id: { S: 'web-001' },
                                        timestamp: { S: '2024-01-15T10:00:00Z' },
                                        workflowId: { S: 'wf-alpha' },
                                        status: { S: 'completed' },
                                    },
                                },
                            },
                            {
                                PutRequest: {
                                    Item: {
                                        id: { S: 'web-002' },
                                        timestamp: { S: '2024-01-15T11:30:00Z' },
                                        workflowId: { S: 'wf-beta' },
                                        status: { S: 'processing' },
                                    },
                                },
                            },
                            {
                                PutRequest: {
                                    Item: {
                                        id: { S: 'web-003' },
                                        timestamp: { S: '2024-01-15T12:45:00Z' },
                                        workflowId: { S: 'wf-alpha' },
                                        status: { S: 'completed' },
                                    },
                                },
                            },
                        ],
                    },
                },
                physicalResourceId: cr.PhysicalResourceId.of('sample-data'),
            },
            policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [table.tableArn] }),
        });

        StackUtils.exportStack(this, 'DynamoDBTableName', table.tableName, 'Name of the DynamoDB table');
        StackUtils.exportStack(this, 'SamplesEndpoint', `${api.url}samples`, 'GET /samples - Retrieve sample records');
        StackUtils.exportStack(this, 'CountEndpoint', `${api.url}count`, 'GET /count - Count completed records');
        StackUtils.exportStack(
            this,
            'WorkflowsEndpoint',
            `${api.url}workflows`,
            'GET /workflows - List unique workflow IDs',
        );
    }
}
