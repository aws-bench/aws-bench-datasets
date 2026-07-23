import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';
import * as path from 'path';

export class WebSocketStack_d761a646a extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // DynamoDB tables
        const connectionsTable = new dynamodb.Table(this, 'ConnectionsTable', {
            tableName: 'flint-websocket-connections',
            partitionKey: {
                name: 'connectionId',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const nodesTable = new dynamodb.Table(this, 'NodesTable', {
            tableName: 'flint-nodes',
            partitionKey: {
                name: 'nodeId',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const deploymentsTable = new dynamodb.Table(this, 'DeploymentsTable', {
            tableName: 'flint-deployments',
            partitionKey: {
                name: 'deploymentId',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Lambda execution role
        const lambdaRole = new iam.Role(this, 'LambdaExecutionRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
            ],
        });

        lambdaRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'dynamodb:PutItem',
                'dynamodb:GetItem',
                'dynamodb:UpdateItem',
                'dynamodb:DeleteItem',
                'dynamodb:Query',
                'dynamodb:Scan',
            ],
            resources: [
                connectionsTable.tableArn,
                nodesTable.tableArn,
                deploymentsTable.tableArn,
            ],
        }));

        // Lambda log group
        const logGroup = new logs.LogGroup(this, 'LambdaLogGroup', {
            logGroupName: '/aws/lambda/flint-agent-message',
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Lambda function
        const messageHandler = new lambda.Function(this, 'MessageHandler', {
            functionName: 'flint-agent-message',
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'agent-message.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/lambda-handler')),
            timeout: cdk.Duration.seconds(30),
            memorySize: 128,
            role: lambdaRole,
            environment: {
                CONNECTIONS_TABLE_NAME: connectionsTable.tableName,
                WEBSOCKET_CONNECTIONS_TABLE: connectionsTable.tableName,
                DEPLOYMENTS_TABLE: deploymentsTable.tableName,
                NODES_TABLE: nodesTable.tableName,
                DEPLOYMENTS_TABLE_NAME: deploymentsTable.tableName,
                NODES_TABLE_NAME: nodesTable.tableName,
            },
            logGroup: logGroup,
        });

        // WebSocket API
        const webSocketApi = new apigatewayv2.CfnApi(this, 'WebSocketApi', {
            name: 'FlintStreamManagerWebSocketAPI',
            protocolType: 'WEBSOCKET',
            routeSelectionExpression: '$request.body.action',
        });

        const integration = new apigatewayv2.CfnIntegration(this, 'LambdaIntegration', {
            apiId: webSocketApi.ref,
            integrationType: 'AWS_PROXY',
            integrationUri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${messageHandler.functionArn}/invocations`,
        });

        const connectRoute = new apigatewayv2.CfnRoute(this, 'ConnectRoute', {
            apiId: webSocketApi.ref,
            routeKey: '$connect',
            target: `integrations/${integration.ref}`,
        });

        const defaultRoute = new apigatewayv2.CfnRoute(this, 'DefaultRoute', {
            apiId: webSocketApi.ref,
            routeKey: '$default',
            target: `integrations/${integration.ref}`,
        });

        const disconnectRoute = new apigatewayv2.CfnRoute(this, 'DisconnectRoute', {
            apiId: webSocketApi.ref,
            routeKey: '$disconnect',
            target: `integrations/${integration.ref}`,
        });

        const deployment = new apigatewayv2.CfnDeployment(this, 'Deployment', {
            apiId: webSocketApi.ref,
        });
        deployment.addDependency(connectRoute);
        deployment.addDependency(defaultRoute);
        deployment.addDependency(disconnectRoute);

        const stage = new apigatewayv2.CfnStage(this, 'ProdStage', {
            apiId: webSocketApi.ref,
            stageName: 'prod',
            deploymentId: deployment.ref,
        });

        messageHandler.addPermission('ApiGatewayInvoke', {
            principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
            sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${webSocketApi.ref}/*`,
        });

        lambdaRole.addToPolicy(new iam.PolicyStatement({
            actions: ['execute-api:ManageConnections'],
            resources: [`arn:aws:execute-api:${this.region}:${this.account}:${webSocketApi.ref}/*`],
        }));

        // S3 bucket for agent scripts
        const agentScriptsBucket = new s3.Bucket(this, 'AgentScriptsBucket', {
            bucketName: `flint-agent-scripts-${this.account}`,
            versioned: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        new s3deploy.BucketDeployment(this, 'DeployAgentScripts', {
            sources: [s3deploy.Source.asset(path.join(__dirname, '../../assets/agent-scripts'))],
            destinationBucket: agentScriptsBucket,
        });

        // Harden the autoDeleteObjects handler with identity-based S3 grants.
        // By default the handler role's ONLY S3 access is the grant each bucket
        // policy gives its exact role ARN. If that grant is stale or gone at
        // delete time, the handler fails its first call (s3:GetBucketTagging)
        // with AccessDenied, the stack delete force-abandons these FIXED-NAME
        // buckets, and every later deploy fails changeset validation with
        // "already exists" — an unrecoverable reset->redeploy loop. Granting
        // the role directly removes the dependence on bucket-policy survival.
        const autoDeleteProvider = this.node.tryFindChild(
            'Custom::S3AutoDeleteObjectsCustomResourceProvider',
        ) as cdk.CustomResourceProviderBase | undefined;
        autoDeleteProvider?.addToRolePolicy({
            Effect: 'Allow',
            Action: ['s3:GetBucket*', 's3:List*', 's3:DeleteObject*', 's3:PutBucketPolicy'],
            Resource: [
                agentScriptsBucket.bucketArn,
                `${agentScriptsBucket.bucketArn}/*`,
            ],
        });

        // Exports
        StackUtils.exportStack(this, 'WebSocketApiId', webSocketApi.ref, 'WebSocket API ID');
        StackUtils.exportStack(this, 'WebSocketEndpoint', `wss://${webSocketApi.ref}.execute-api.${this.region}.amazonaws.com/prod`, 'WebSocket endpoint URL');
        StackUtils.exportStack(this, 'LambdaFunctionName', messageHandler.functionName, 'Lambda function name');
        StackUtils.exportStack(this, 'LambdaFunctionArn', messageHandler.functionArn, 'Lambda function ARN');
        StackUtils.exportStack(this, 'LogGroupName', logGroup.logGroupName, 'Lambda log group name');
        StackUtils.exportStack(this, 'AgentScriptsBucketName', agentScriptsBucket.bucketName, 'Agent scripts bucket');
        StackUtils.exportStack(this, 'ConnectionsTableName', connectionsTable.tableName, 'WebSocket connections table');
        StackUtils.exportStack(this, 'NodesTableName', nodesTable.tableName, 'Nodes table');
        StackUtils.exportStack(this, 'DeploymentsTableName', deploymentsTable.tableName, 'Deployments table');
    }
}
