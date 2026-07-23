import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import { StackUtils } from '../../lib/shared';

export class ApiGatewayTokenAuthStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // CloudWatch Log Group for API Gateway access logs
        const logGroup = new logs.LogGroup(this, 'ApiGatewayAuthLambdaLogGroup', {
            logGroupName: 'apigateway-auth-lambda',
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Operational Lambda function
        const operationalFunction = new lambda.Function(this, 'OperationalFunction', {
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/apigateway-token-operational')),
        });
        operationalFunction.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Authorizer Lambda function
        const authorizerFunction = new lambda.Function(this, 'AuthorizerFunction', {
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/apigateway-token-authorizer')),
        });
        authorizerFunction.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Token Authorizer for API Gateway
        const tokenAuthorizer = new apigateway.TokenAuthorizer(this, 'TokenAuthorizer', {
            handler: authorizerFunction,
        });

        // LambdaRestApi with the operational function
        const api = new apigateway.LambdaRestApi(this, 'AuthApi', {
            handler: operationalFunction,
            deploy: true,
            deployOptions: {
                stageName: 'prod',
                accessLogDestination: new apigateway.LogGroupLogDestination(logGroup),
            },
            proxy: false,
        });

        // /health resource with GET method using Token authorizer
        const healthResource = api.root.addResource('health');
        healthResource.addMethod('GET', new apigateway.LambdaIntegration(operationalFunction), {
            authorizer: tokenAuthorizer,
            authorizationType: apigateway.AuthorizationType.CUSTOM,
        });

        // Exports
        StackUtils.exportStack(this, 'ApiEndpoint', api.url, 'API Gateway endpoint URL');
        StackUtils.exportStack(this, 'ApiId', api.restApiId, 'API Gateway REST API ID');
        StackUtils.exportStack(this, 'AuthorizerFunctionName', authorizerFunction.functionName, 'Authorizer Lambda function name');
        StackUtils.exportStack(this, 'OperationalFunctionName', operationalFunction.functionName, 'Operational Lambda function name');
        StackUtils.exportStack(this, 'AuthorizerType', 'TOKEN', 'Type of API Gateway authorizer');
        StackUtils.exportStack(this, 'StageName', 'prod', 'API Gateway deployment stage name');
    }
}
