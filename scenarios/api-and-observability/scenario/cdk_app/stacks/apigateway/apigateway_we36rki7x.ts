import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';
import * as path from 'path';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: apigateway-we36rki7x
 *
 * 58b58a5d-faa4-40b5-89aa-94e6ca83081b
 *
 * What the stack does:
 * 1. Creates a WebSocket API Gateway with Lambda integration
 * 2. Creates DynamoDB tables for connections, nodes, and deployments
 * 3. Creates CloudWatch Log Group for Lambda
 */

export class apigateway_we36rki7x extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // DynamoDB Tables
        const connectionsTable = new dynamodb.Table(this, 'ConnectionsTable', {
            tableName: `flint-websocket-connections-${this.account}-${this.region}`,
            partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const nodesTable = new dynamodb.Table(this, 'NodesTable', {
            tableName: `flint-nodes-${this.account}-${this.region}`,
            partitionKey: { name: 'nodeId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const deploymentsTable = new dynamodb.Table(this, 'DeploymentsTable', {
            tableName: `flint-deployments-${this.account}-${this.region}`,
            partitionKey: { name: 'deploymentId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // CloudWatch Log Group for Lambda
        const logGroup = new logs.LogGroup(this, 'LambdaLogGroup', {
            logGroupName: `/aws/lambda/flint-agent-message-${this.account}-${this.region}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // IAM Role for Lambda
        const lambdaRole = new iam.Role(this, 'LambdaExecutionRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
            ],
        });

        // Grant DynamoDB permissions
        connectionsTable.grantReadWriteData(lambdaRole);
        nodesTable.grantReadWriteData(lambdaRole);
        deploymentsTable.grantReadWriteData(lambdaRole);

        // Lambda function for WebSocket message handling
        const agentMessageLambda = new lambda.Function(this, 'AgentMessageLambda', {
            functionName: `flint-agent-message-${this.account}-${this.region}`,
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'agent-message.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/lambda-handler')),
            timeout: cdk.Duration.seconds(30),
            memorySize: 128,
            role: lambdaRole,
            logGroup: logGroup,
            environment: {
                CONNECTIONS_TABLE_NAME: connectionsTable.tableName,
                NODES_TABLE: nodesTable.tableName,
                DEPLOYMENTS_TABLE: deploymentsTable.tableName,
            },
        });

        // WebSocket API
        const webSocketApi = new apigwv2.WebSocketApi(this, 'WebSocketApi', {
            apiName: `Flint-WebSocket-API-${this.account}-${this.region}`,
            routeSelectionExpression: '$request.body.action',
            connectRouteOptions: {
                integration: new WebSocketLambdaIntegration('ConnectIntegration', agentMessageLambda),
            },
            disconnectRouteOptions: {
                integration: new WebSocketLambdaIntegration('DisconnectIntegration', agentMessageLambda),
            },
            defaultRouteOptions: {
                integration: new WebSocketLambdaIntegration('DefaultIntegration', agentMessageLambda),
            },
        });

        // WebSocket Stage
        const webSocketStage = new apigwv2.WebSocketStage(this, 'WebSocketStage', {
            webSocketApi,
            stageName: 'prod',
            autoDeploy: true,
        });

        // Grant Lambda permission to manage WebSocket connections
        lambdaRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['execute-api:ManageConnections'],
            resources: [
                `arn:aws:execute-api:${this.region}:${this.account}:${webSocketApi.apiId}/*`,
            ],
        }));

        // Outputs
        StackUtils.exportStack(this, 'WebSocketApiId', webSocketApi.apiId, 'WebSocket API ID');
        StackUtils.exportStack(this, 'WebSocketApiEndpoint', webSocketStage.url, 'WebSocket API Endpoint');
        StackUtils.exportStack(this, 'LambdaFunctionName', agentMessageLambda.functionName, 'Lambda Function Name');
        StackUtils.exportStack(this, 'LambdaFunctionArn', agentMessageLambda.functionArn, 'Lambda Function ARN');
        StackUtils.exportStack(this, 'ConnectionsTableName', connectionsTable.tableName, 'Connections Table Name');
        StackUtils.exportStack(this, 'NodesTableName', nodesTable.tableName, 'Nodes Table Name');
        StackUtils.exportStack(this, 'DeploymentsTableName', deploymentsTable.tableName, 'Deployments Table Name');
        StackUtils.exportStack(this, 'LogGroupName', logGroup.logGroupName, 'Lambda Log Group Name');
    }
}
