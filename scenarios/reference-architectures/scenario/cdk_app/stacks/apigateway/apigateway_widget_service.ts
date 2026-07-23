import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { StackUtils } from '../../lib/shared';

/*
 * Stack: ApiGatewayWidgetService
 *
 * What the stack does:
 * 1. Creates an S3 bucket for storing widgets
 * 2. Creates a Lambda function that handles GET, POST, DELETE operations against S3
 * 3. Creates an API Gateway REST API with API key authentication
 * 4. / root resource with GET (list widgets)
 * 5. /{id} resource with POST (create widget), GET (get widget), and DELETE (delete widget)
 */

export class ApiGatewayWidgetService extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // S3 bucket for widget storage
        const widgetBucket = new s3.Bucket(this, 'WidgetBucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
        });

        // Lambda function for widget operations
        const widgetHandlerFn = new lambda.Function(this, 'WidgetHandlerFunction', {
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/apigateway-widget-handler')),
            environment: {
                BUCKET: widgetBucket.bucketName,
            },
            timeout: cdk.Duration.seconds(30),
        });

        // Grant Lambda read/write access to the bucket
        widgetBucket.grantReadWrite(widgetHandlerFn);

        // REST API with API key authentication
        const api = new apigateway.RestApi(this, 'WidgetServiceApi', {
            restApiName: 'WidgetService',
            description: 'Widget service backed by S3',
            deployOptions: {
                stageName: 'prod',
            },
            defaultMethodOptions: {
                apiKeyRequired: true,
            },
        });

        // API Key and Usage Plan
        const apiKey = api.addApiKey('WidgetServiceApiKey');
        const usagePlan = api.addUsagePlan('WidgetServiceUsagePlan', {
            name: 'WidgetServiceUsagePlan',
            throttle: {
                rateLimit: 10,
                burstLimit: 5,
            },
        });
        usagePlan.addApiKey(apiKey);
        usagePlan.addApiStage({ stage: api.deploymentStage });

        const getWidgetsIntegration = new apigateway.LambdaIntegration(widgetHandlerFn, {
            requestTemplates: { "application/json": '{ "statusCode": "200" }' },
        });

        // / root resource with GET
        api.root.addMethod('GET', getWidgetsIntegration);

        // /{id} resource with POST, GET, and DELETE
        const widget = api.root.addResource('{id}');

        const postWidgetIntegration = new apigateway.LambdaIntegration(widgetHandlerFn);
        const getWidgetIntegration = new apigateway.LambdaIntegration(widgetHandlerFn);
        const deleteWidgetIntegration = new apigateway.LambdaIntegration(widgetHandlerFn);

        widget.addMethod('POST', postWidgetIntegration);
        widget.addMethod('GET', getWidgetIntegration);
        widget.addMethod('DELETE', deleteWidgetIntegration);

        // Exports
        StackUtils.exportStack(this, 'ApiEndpoint', api.url, 'API Gateway endpoint URL');
        StackUtils.exportStack(this, 'ApiId', api.restApiId, 'API Gateway REST API ID');
        StackUtils.exportStack(this, 'ApiKeyId', apiKey.keyId, 'API Key ID');
        StackUtils.exportStack(this, 'BucketName', widgetBucket.bucketName, 'S3 widget bucket name');
        StackUtils.exportStack(this, 'BucketArn', widgetBucket.bucketArn, 'S3 widget bucket ARN');
        StackUtils.exportStack(this, 'FunctionName', widgetHandlerFn.functionName, 'Lambda function name');
        StackUtils.exportStack(this, 'SupportedMethods', 'GET /, POST|GET|DELETE /{id}', 'Supported HTTP methods');
    }
}
