import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';
import * as path from 'path';

export class ApiGateway6b015c55c extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // DynamoDB table to store data agreements
        const agreementsTable = new dynamodb.Table(this, 'AgreementsTable', {
            partitionKey: { name: 'agreementId', type: dynamodb.AttributeType.STRING },
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

        agreementsTable.grantReadData(lambdaRole);

        // Lambda function to retrieve data agreements
        const getAgreementFunction = new lambda.Function(this, 'GetAgreementFunction', {
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/get_agreement')),
            role: lambdaRole,
            environment: {
                TABLE_NAME: agreementsTable.tableName,
            },
            timeout: cdk.Duration.seconds(30),
        });

        // API Gateway REST API
        const api = new apigateway.RestApi(this, 'ServiceApi', {
            restApiName: 'QuartzD3AService',
            description: 'Data Access Aggregator & Auditor Service API',
            endpointConfiguration: {
                types: [apigateway.EndpointType.REGIONAL],
            },
            deployOptions: {
                stageName: 'beta',
            },
        });

        // Resource: /data-agreements
        const dataAgreementsResource = api.root.addResource('data-agreements');
        
        // Resource: /data-agreements/{agreementId}
        const agreementIdResource = dataAgreementsResource.addResource('{agreementId}');

        // Integration with Lambda
        const lambdaIntegration = new apigateway.LambdaIntegration(getAgreementFunction, {
            proxy: true,
        });

        // GET method on /data-agreements/{agreementId}
        agreementIdResource.addMethod('GET', lambdaIntegration, {
            authorizationType: apigateway.AuthorizationType.IAM,
        });

        // Role for legacy data export pipeline integration
        const dataExportRole = new iam.Role(this, 'DataExportRole', {
            assumedBy: new iam.AccountPrincipal(this.account),
            description: 'Role for data export API integration',
        });

        dataExportRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'execute-api:Invoke',
            ],
            resources: [
                `arn:aws:execute-api:${this.region}:${this.account}:a1b2c3d4e5/beta/GET/*`,
            ],
        }));

        // Role for client access to service endpoints
        const restrictedRole = new iam.Role(this, 'RestrictedAccessRole', {
            assumedBy: new iam.AccountPrincipal(this.account),
            description: 'Role for accessing service endpoints',
        });

        restrictedRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'execute-api:Invoke',
            ],
            resources: [
                `arn:aws:execute-api:${this.region}:${this.account}:${api.restApiId}/beta/POST/*`,
            ],
        }));

        StackUtils.exportStack(this, 'ApiId', api.restApiId, 'API Gateway REST API ID');
        StackUtils.exportStack(this, 'ApiUrl', api.url, 'API Gateway endpoint URL');
        StackUtils.exportStack(this, 'StageName', 'beta', 'API Gateway stage name');
        StackUtils.exportStack(this, 'TableName', agreementsTable.tableName, 'DynamoDB table name');
        StackUtils.exportStack(this, 'LambdaFunctionName', getAgreementFunction.functionName, 'Lambda function name');
        StackUtils.exportStack(this, 'LambdaFunctionArn', getAgreementFunction.functionArn, 'Lambda function ARN');
        StackUtils.exportStack(this, 'RestrictedRoleArn', restrictedRole.roleArn, 'IAM role ARN');
        StackUtils.exportStack(this, 'AgreementId', 'dua-2024-001', 'Data Usage Agreement ID');
        StackUtils.exportStack(this, 'AgreementPath', '/data-agreements/dua-2024-001', 'API path to agreement');
    }
}
