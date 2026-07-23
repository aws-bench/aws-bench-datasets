import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack: ApiGatewayWebsocket
 *
 * Converted from aws-cdk-examples/typescript/api-websocket-lambda-dynamodb.
 * SECURITY FIX: uses AWS_IAM auth on $connect route.
 *
 * Resources created:
 * 1. DynamoDB Table (connectionId partition key)
 * 2. Lambda onConnect (stores connection in DynamoDB)
 * 3. Lambda onDisconnect (removes connection from DynamoDB)
 * 4. Lambda sendMessage (broadcasts message to all connections)
 * 5. WebSocket API (CfnApi) with routes: $connect, $disconnect, sendmessage
 * 6. CfnStage (dev, autoDeploy)
 * 7. IAM Role for API Gateway Lambda invocation
 */

export class ApiGatewayWebsocket extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // DynamoDB Table for WebSocket connections
        const connectionsTable = new dynamodb.Table(this, 'ConnectionsTable', {
            partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Lambda: onConnect
        const onConnectFn = new lambda.Function(this, 'OnConnectFunction', {
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/apigateway-ws-on-connect')),
            environment: {
                TABLE_NAME: connectionsTable.tableName,
            },
            timeout: cdk.Duration.seconds(30),
        });

        // Lambda: onDisconnect
        const onDisconnectFn = new lambda.Function(this, 'OnDisconnectFunction', {
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/apigateway-ws-on-disconnect')),
            environment: {
                TABLE_NAME: connectionsTable.tableName,
            },
            timeout: cdk.Duration.seconds(30),
        });

        // Lambda: sendMessage
        const sendMessageFn = new lambda.Function(this, 'SendMessageFunction', {
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/apigateway-ws-send-message')),
            environment: {
                TABLE_NAME: connectionsTable.tableName,
            },
            timeout: cdk.Duration.seconds(30),
        });

        // Grant DynamoDB permissions
        connectionsTable.grantReadWriteData(onConnectFn);
        connectionsTable.grantReadWriteData(onDisconnectFn);
        connectionsTable.grantReadWriteData(sendMessageFn);

        // WebSocket API (CfnApi)
        const webSocketApi = new apigatewayv2.CfnApi(this, 'WebSocketApi', {
            name: 'WebSocketChat',
            protocolType: 'WEBSOCKET',
            routeSelectionExpression: '$request.body.action',
        });

        // IAM Role for API Gateway to invoke Lambda functions
        const apiGatewayRole = new iam.Role(this, 'ApiGatewayLambdaRole', {
            assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
        });
        onConnectFn.grantInvoke(apiGatewayRole);
        onDisconnectFn.grantInvoke(apiGatewayRole);
        sendMessageFn.grantInvoke(apiGatewayRole);

        // Integrations
        const connectIntegration = new apigatewayv2.CfnIntegration(this, 'ConnectIntegration', {
            apiId: webSocketApi.ref,
            integrationType: 'AWS_PROXY',
            integrationUri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${onConnectFn.functionArn}/invocations`,
            credentialsArn: apiGatewayRole.roleArn,
        });

        const disconnectIntegration = new apigatewayv2.CfnIntegration(this, 'DisconnectIntegration', {
            apiId: webSocketApi.ref,
            integrationType: 'AWS_PROXY',
            integrationUri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${onDisconnectFn.functionArn}/invocations`,
            credentialsArn: apiGatewayRole.roleArn,
        });

        const sendMessageIntegration = new apigatewayv2.CfnIntegration(this, 'SendMessageIntegration', {
            apiId: webSocketApi.ref,
            integrationType: 'AWS_PROXY',
            integrationUri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${sendMessageFn.functionArn}/invocations`,
            credentialsArn: apiGatewayRole.roleArn,
        });

        // Routes
        const connectRoute = new apigatewayv2.CfnRoute(this, 'ConnectRoute', {
            apiId: webSocketApi.ref,
            routeKey: '$connect',
            authorizationType: 'AWS_IAM',
            target: `integrations/${connectIntegration.ref}`,
        });

        const disconnectRoute = new apigatewayv2.CfnRoute(this, 'DisconnectRoute', {
            apiId: webSocketApi.ref,
            routeKey: '$disconnect',
            authorizationType: 'NONE',
            target: `integrations/${disconnectIntegration.ref}`,
        });

        const sendMessageRoute = new apigatewayv2.CfnRoute(this, 'SendMessageRoute', {
            apiId: webSocketApi.ref,
            routeKey: 'sendmessage',
            authorizationType: 'NONE',
            target: `integrations/${sendMessageIntegration.ref}`,
        });

        // Deployment
        const deployment = new apigatewayv2.CfnDeployment(this, 'WebSocketDeployment', {
            apiId: webSocketApi.ref,
        });
        deployment.addDependency(connectRoute);
        deployment.addDependency(disconnectRoute);
        deployment.addDependency(sendMessageRoute);

        // Stage
        const stage = new apigatewayv2.CfnStage(this, 'WebSocketStage', {
            apiId: webSocketApi.ref,
            stageName: 'dev',
            autoDeploy: true,
            deploymentId: deployment.ref,
        });

        // Grant execute-api:ManageConnections to sendMessage Lambda
        sendMessageFn.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['execute-api:ManageConnections'],
                resources: [
                    `arn:aws:execute-api:${this.region}:${this.account}:${webSocketApi.ref}/${stage.stageName}/POST/@connections/*`,
                ],
            }),
        );

        // Exports
        StackUtils.exportStack(
            this,
            'WebSocketApiEndpoint',
            `wss://${webSocketApi.ref}.execute-api.${this.region}.amazonaws.com/${stage.stageName}`,
            'WebSocket API endpoint URL',
        );
        StackUtils.exportStack(this, 'WebSocketApiId', webSocketApi.ref, 'WebSocket API ID');
        StackUtils.exportStack(this, 'TableName', connectionsTable.tableName, 'DynamoDB connections table name');
        StackUtils.exportStack(this, 'OnConnectFunctionName', onConnectFn.functionName, 'OnConnect Lambda function name');
        StackUtils.exportStack(this, 'OnDisconnectFunctionName', onDisconnectFn.functionName, 'OnDisconnect Lambda function name');
        StackUtils.exportStack(this, 'SendMessageFunctionName', sendMessageFn.functionName, 'SendMessage Lambda function name');
        StackUtils.exportStack(this, 'StageName', 'dev', 'WebSocket API stage name');
        StackUtils.exportStack(this, 'AuthorizationType', 'AWS_IAM', 'Authorization type for $connect route');
    }
}
