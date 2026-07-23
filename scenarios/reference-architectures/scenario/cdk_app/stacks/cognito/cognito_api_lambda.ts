import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { StackUtils } from '../../lib/shared';

export class CognitoApiLambdaStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // Cognito User Pool
        const userPool = new cognito.UserPool(this, 'UserPool', {
            signInAliases: { email: true },
            selfSignUpEnabled: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Lambda function
        const helloFunction = new lambda.Function(this, 'HelloFunction', {
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/cognito-hello')),
        });
        helloFunction.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // LambdaRestApi
        const api = new apigateway.LambdaRestApi(this, 'HelloApi', {
            handler: helloFunction,
            proxy: false,
        });

        // Cognito Authorizer using CfnAuthorizer
        const cognitoAuthorizer = new apigateway.CfnAuthorizer(this, 'CognitoAuthorizer', {
            restApiId: api.restApiId,
            name: 'CognitoAuthorizer',
            type: 'COGNITO_USER_POOLS',
            identitySource: 'method.request.header.Authorization',
            providerArns: [userPool.userPoolArn],
        });

        // /HELLO resource with GET method using Cognito authorizer
        const helloResource = api.root.addResource('HELLO');
        helloResource.addMethod('GET', new apigateway.LambdaIntegration(helloFunction), {
            authorizationType: apigateway.AuthorizationType.COGNITO,
            authorizer: {
                authorizerId: cognitoAuthorizer.ref,
            },
        });

        // Exports
        StackUtils.exportStack(this, 'ApiEndpoint', api.url, 'API Gateway endpoint URL');
        StackUtils.exportStack(this, 'ApiId', api.restApiId, 'API Gateway REST API ID');
        StackUtils.exportStack(this, 'UserPoolId', userPool.userPoolId, 'Cognito User Pool ID');
        StackUtils.exportStack(this, 'UserPoolArn', userPool.userPoolArn, 'Cognito User Pool ARN');
        StackUtils.exportStack(this, 'AuthorizerType', 'COGNITO_USER_POOLS', 'Type of API Gateway authorizer');
        StackUtils.exportStack(this, 'FunctionName', helloFunction.functionName, 'Lambda function name');
        StackUtils.exportStack(this, 'ResourcePath', '/HELLO', 'API Gateway resource path');
    }
}
