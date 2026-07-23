import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { StackUtils } from '../../lib/shared';

/*
 * Stack: ApiGatewayAsyncLambda
 *
 * What the stack does:
 * 1. Creates a DynamoDB table for storing async job results
 * 2. Creates a CloudWatch LogGroup for API access logging
 * 3. Creates a Lambda function for async job processing
 * 4. Creates an API Gateway REST API with API key authentication
 * 5. POST /job invokes Lambda asynchronously via X-Amz-Invocation-Type: Event
 * 6. GET /{jobId} reads directly from DynamoDB via AWS service integration
 */

export class ApiGatewayAsyncLambda extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // DynamoDB table for job results
        const jobTable = new dynamodb.Table(this, 'JobTable', {
            partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // CloudWatch LogGroup for API access logs
        const logGroup = new logs.LogGroup(this, 'ApiAccessLogGroup', {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Lambda function for async job processing
        const jobProcessorFn = new lambda.Function(this, 'JobProcessorFunction', {
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/apigateway-async-job-processor')),
            environment: {
                JOB_TABLE: jobTable.tableName,
            },
            timeout: cdk.Duration.seconds(30),
        });

        // Grant Lambda read/write to DynamoDB
        jobTable.grantReadWriteData(jobProcessorFn);

        // REST API with API key authentication
        const api = new apigateway.RestApi(this, 'AsyncJobApi', {
            restApiName: 'AsyncJobService',
            description: 'API Gateway with async Lambda invocation and DynamoDB integration',
            deployOptions: {
                stageName: 'prod',
                accessLogDestination: new apigateway.LogGroupLogDestination(logGroup),
            },
            defaultMethodOptions: {
                apiKeyRequired: true,
            },
        });

        // API Key and Usage Plan
        const apiKey = api.addApiKey('AsyncJobApiKey');
        const usagePlan = api.addUsagePlan('AsyncJobUsagePlan', {
            name: 'AsyncJobUsagePlan',
            throttle: {
                rateLimit: 10,
                burstLimit: 5,
            },
        });
        usagePlan.addApiKey(apiKey);
        usagePlan.addApiStage({ stage: api.deploymentStage });

        // POST /job - Async Lambda invocation with custom request/response templates
        const jobResource = api.root.addResource('job');
        jobResource.addMethod('POST',
            new apigateway.LambdaIntegration(jobProcessorFn, {
                proxy: false,
                requestParameters: {
                    'integration.request.header.X-Amz-Invocation-Type': "'Event'",
                },
                requestTemplates: {
                    'application/json': `{
            "jobId": "$context.requestId",
            "body": $input.json('$')
          }`,
                },
                integrationResponses: [
                    {
                        statusCode: '200',
                        responseTemplates: {
                            'application/json': `{"jobId": "$context.requestId"}`,
                        },
                    },
                    {
                        statusCode: '500',
                        responseTemplates: {
                            'application/json': `{
                "error": "An error occurred while processing the request.",
                "details": "$context.integrationErrorMessage"
              }`,
                        },
                    },
                ],
            }),
            {
                methodResponses: [
                    {
                        statusCode: '200',
                    },
                    {
                        statusCode: '500',
                    },
                ],
            },
        );

        // IAM Role for API Gateway -> DynamoDB GetItem
        const apiGwDynamoRole = new iam.Role(this, 'ApiGwDynamoRole', {
            assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
        });
        jobTable.grantReadData(apiGwDynamoRole);

        // GET /job/{jobId} - Direct DynamoDB integration with response shaping
        const jobIdResource = jobResource.addResource('{jobId}');
        jobIdResource.addMethod('GET',
            new apigateway.AwsIntegration({
                service: 'dynamodb',
                action: 'GetItem',
                options: {
                    credentialsRole: apiGwDynamoRole,
                    requestTemplates: {
                        'application/json': `{
              "TableName": "${jobTable.tableName}",
              "Key": {
                "jobId": {
                  "S": "$input.params('jobId')"
                }
              }
            }`,
                    },
                    integrationResponses: [
                        {
                            statusCode: '200',
                            responseTemplates: {
                                'application/json': `{
                "jobId": "$input.path('$.Item.jobId.S')",
                "status": "$input.path('$.Item.status.S')",
                "createdAt": "$input.path('$.Item.createdAt.S')"
              }`,
                            },
                        },
                        {
                            statusCode: '404',
                            selectionPattern: '.*"Item":null.*',
                            responseTemplates: {
                                'application/json': '{"error": "Job not found"}',
                            },
                        },
                    ],
                },
            }),
            {
                methodResponses: [
                    {
                        statusCode: '200',
                    },
                    {
                        statusCode: '404',
                    },
                ],
            },
        );

        // Exports
        StackUtils.exportStack(this, 'ApiEndpoint', api.url, 'API Gateway endpoint URL');
        StackUtils.exportStack(this, 'ApiId', api.restApiId, 'API Gateway REST API ID');
        StackUtils.exportStack(this, 'ApiKeyId', apiKey.keyId, 'API Key ID');
        StackUtils.exportStack(this, 'TableName', jobTable.tableName, 'DynamoDB table name');
        StackUtils.exportStack(this, 'TableArn', jobTable.tableArn, 'DynamoDB table ARN');
        StackUtils.exportStack(this, 'FunctionName', jobProcessorFn.functionName, 'Lambda function name');
        StackUtils.exportStack(this, 'PostResourcePath', '/job', 'POST resource path');
        StackUtils.exportStack(this, 'GetResourcePath', '/job/{jobId}', 'GET resource path');
    }
}
