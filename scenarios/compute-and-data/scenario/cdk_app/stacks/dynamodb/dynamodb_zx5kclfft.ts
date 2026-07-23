import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * ValidationStack ID: dynamodb_zx5kclfft
 *
 * The stack creates the following resources:
 *
 * 1. Old DynamoDB table with basic validation data
 * 2. New DynamoDB table with latest validation data (status, reason, compliance, timestamp)
 * 3. Lambda function querying old table (ERROR scenario)
 *
 */

export class dynamodb_zx5kclfft extends cdk.Stack {
    private readonly accountId: string;

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        this.accountId = this.account;

        // Old validation table - basic validation data
        const oldValidationTable = new dynamodb.Table(this, 'OldValidationTable', {
            tableName: `old-whg34h5b-${this.accountId}-${this.region}`,
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        oldValidationTable.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // New validation table - enhanced with status, reason, compliance, timestamp
        const newValidationTable = new dynamodb.Table(this, 'NewValidationTable', {
            tableName: `latest-3hg2h54-${this.accountId}-${this.region}`,
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        newValidationTable.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Lambda function with ERROR - queries old table instead of new table
        const validationFunction = new lambda.Function(this, 'ValidationFunction', {
            runtime: lambda.Runtime.PYTHON_3_11,
            handler: 'index.handler',
            timeout: cdk.Duration.seconds(30),
            code: lambda.Code.fromInline(`
import boto3
import json
import os

def handler(event, context):
    dynamodb = boto3.resource('dynamodb')
    
    table = dynamodb.Table(os.environ['OLD_TABLE_NAME'])
    
    try:
        response = table.get_item(Key={'id': event.get('validation_id', 'default')})
        
        if 'Item' not in response:
            return {'statusCode': 404, 'body': json.dumps({'error': 'Validation data not found'})}
        
        return {
            'statusCode': 200,
            'body': json.dumps({'validation_id': response['Item'].get('id'), 'basic_data': response['Item'].get('data')})
        }
    except Exception as e:
        return {'statusCode': 500, 'body': json.dumps({'error': str(e)})}
`),
            environment: {
                OLD_TABLE_NAME: oldValidationTable.tableName,
            },
        });
        validationFunction.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // IAM policy for old table access
        validationFunction.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['dynamodb:GetItem'],
                resources: [oldValidationTable.tableArn],
            }),
        );

        // Export stack information
        StackUtils.exportStack(this, 'OldTableName', oldValidationTable.tableName);
        StackUtils.exportStack(this, 'NewTableName', newValidationTable.tableName);
        StackUtils.exportStack(this, 'ValidationFunctionName', validationFunction.functionName);
    }
}
