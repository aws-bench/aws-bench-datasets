import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { IResource } from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { StackUtils } from '../../lib/shared';

/*
 * Stack: ApiGatewayCrudDynamodb
 *
 * What the stack does:
 * 1. Creates a DynamoDB table with partition key itemId
 * 2. Creates 5 Lambda functions for CRUD operations (getOne, getAll, create, updateOne, deleteOne)
 * 3. Creates an API Gateway REST API with API key authentication
 * 4. /items resource with GET (getAll) and POST (create)
 * 5. /items/{id} resource with GET (getOne), PATCH (updateOne), DELETE (deleteOne)
 */

export class ApiGatewayCrudDynamodb extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const primaryKey = 'itemId';

        // DynamoDB table
        const itemsTable = new dynamodb.Table(this, 'ItemsTable', {
            partitionKey: { name: primaryKey, type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const commonEnv = {
            TABLE_NAME: itemsTable.tableName,
            PRIMARY_KEY: primaryKey,
        };

        // getOne Lambda
        const getOneFn = new lambda.Function(this, 'GetOneFunction', {
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/apigateway-crud-get-one')),
            environment: commonEnv,
            timeout: cdk.Duration.seconds(30),
        });

        // getAll Lambda
        const getAllFn = new lambda.Function(this, 'GetAllFunction', {
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/apigateway-crud-get-all')),
            environment: commonEnv,
            timeout: cdk.Duration.seconds(30),
        });

        // create Lambda
        const createFn = new lambda.Function(this, 'CreateFunction', {
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/apigateway-crud-create')),
            environment: commonEnv,
            timeout: cdk.Duration.seconds(30),
        });

        // updateOne Lambda
        const updateOneFn = new lambda.Function(this, 'UpdateOneFunction', {
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/apigateway-crud-update-one')),
            environment: commonEnv,
            timeout: cdk.Duration.seconds(30),
        });

        // deleteOne Lambda
        const deleteOneFn = new lambda.Function(this, 'DeleteOneFunction', {
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/apigateway-crud-delete-one')),
            environment: commonEnv,
            timeout: cdk.Duration.seconds(30),
        });

        // Grant DynamoDB permissions
        itemsTable.grantReadData(getAllFn);
        itemsTable.grantReadData(getOneFn);
        itemsTable.grantReadWriteData(createFn);
        itemsTable.grantReadWriteData(updateOneFn);
        itemsTable.grantReadWriteData(deleteOneFn);

        // REST API with API key authentication
        const api = new apigateway.RestApi(this, 'ItemsCrudApi', {
            restApiName: 'ItemsCrudService',
            description: 'CRUD API for items backed by DynamoDB',
            deployOptions: {
                stageName: 'prod',
            },
            defaultMethodOptions: {
                apiKeyRequired: true,
            },
        });

        // API Key and Usage Plan
        const apiKey = api.addApiKey('ItemsCrudApiKey');
        const usagePlan = api.addUsagePlan('ItemsCrudUsagePlan', {
            name: 'ItemsCrudUsagePlan',
            throttle: {
                rateLimit: 10,
                burstLimit: 5,
            },
        });
        usagePlan.addApiKey(apiKey);
        usagePlan.addApiStage({ stage: api.deploymentStage });

        // Integrate the Lambda functions with the API Gateway resource
        const getAllIntegration = new apigateway.LambdaIntegration(getAllFn);
        const createOneIntegration = new apigateway.LambdaIntegration(createFn);
        const getOneIntegration = new apigateway.LambdaIntegration(getOneFn);
        const updateOneIntegration = new apigateway.LambdaIntegration(updateOneFn);
        const deleteOneIntegration = new apigateway.LambdaIntegration(deleteOneFn);

        // /items resource
        const itemsResource = api.root.addResource('items');
        itemsResource.addMethod('GET', getAllIntegration);
        itemsResource.addMethod('POST', createOneIntegration);
        addCorsOptions(itemsResource);

        // /items/{id} resource
        const itemIdResource = itemsResource.addResource('{id}');
        itemIdResource.addMethod('GET', getOneIntegration);
        itemIdResource.addMethod('PATCH', updateOneIntegration);
        itemIdResource.addMethod('DELETE', deleteOneIntegration);
        addCorsOptions(itemIdResource);

        // Exports
        StackUtils.exportStack(this, 'ApiEndpoint', api.url, 'API Gateway endpoint URL');
        StackUtils.exportStack(this, 'ApiId', api.restApiId, 'API Gateway REST API ID');
        StackUtils.exportStack(this, 'ApiKeyId', apiKey.keyId, 'API Key ID');
        StackUtils.exportStack(this, 'TableName', itemsTable.tableName, 'DynamoDB table name');
        StackUtils.exportStack(this, 'TableArn', itemsTable.tableArn, 'DynamoDB table ARN');
        StackUtils.exportStack(this, 'GetOneFunctionName', getOneFn.functionName, 'GetOne Lambda function name');
        StackUtils.exportStack(this, 'GetAllFunctionName', getAllFn.functionName, 'GetAll Lambda function name');
        StackUtils.exportStack(this, 'CreateFunctionName', createFn.functionName, 'Create Lambda function name');
        StackUtils.exportStack(this, 'UpdateFunctionName', updateOneFn.functionName, 'Update Lambda function name');
        StackUtils.exportStack(this, 'DeleteFunctionName', deleteOneFn.functionName, 'Delete Lambda function name');
        StackUtils.exportStack(this, 'PrimaryKey', 'itemId', 'DynamoDB partition key name');
    }
}

export function addCorsOptions(apiResource: IResource) {
    apiResource.addMethod('OPTIONS', new apigateway.MockIntegration({
        integrationResponses: [{
            statusCode: '200',
            responseParameters: {
                'method.response.header.Access-Control-Allow-Headers': "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent'",
                'method.response.header.Access-Control-Allow-Origin': "'*'",
                'method.response.header.Access-Control-Allow-Credentials': "'false'",
                'method.response.header.Access-Control-Allow-Methods': "'OPTIONS,GET,PUT,POST,DELETE'",
            },
        }],
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestTemplates: {
            "application/json": "{\"statusCode\": 200}"
        },
    }), {
        apiKeyRequired: false,
        methodResponses: [{
            statusCode: '200',
            responseParameters: {
                'method.response.header.Access-Control-Allow-Headers': true,
                'method.response.header.Access-Control-Allow-Methods': true,
                'method.response.header.Access-Control-Allow-Credentials': true,
                'method.response.header.Access-Control-Allow-Origin': true,
            },
        }]
    });
}
