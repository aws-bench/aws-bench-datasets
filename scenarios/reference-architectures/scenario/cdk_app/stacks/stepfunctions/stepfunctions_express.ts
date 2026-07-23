import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Step Functions Express with External ASL Definition Stack
 *
 * Converted from aws-cdk-examples/typescript/stepfunction-external-definition
 *
 * Creates:
 * 1. CloudWatch Log Group for state machine execution logs
 * 2. Express State Machine loaded from external ASL JSON file (car order workflow)
 * 3. REST API Gateway with StepFunctions integration (IAM auth)
 */

export class StepFunctionsExpressStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const logGroup = new logs.LogGroup(this, 'StateMachineLogGroup', {
            logGroupName: `/aws/vendedlogs/states/express-sfn-${this.account}-${this.region}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const aslFilePath = path.join(
            __dirname,
            '../../assets/stepfunctions-external-asl/workflow.json',
        );

        const stateMachine = new stepfunctions.StateMachine(this, 'ExpressStateMachine', {
            stateMachineName: `express-sfn-${this.account}-${this.region}`,
            stateMachineType: stepfunctions.StateMachineType.EXPRESS,
            definitionBody: stepfunctions.DefinitionBody.fromFile(aslFilePath),
            logs: {
                destination: logGroup,
                level: stepfunctions.LogLevel.ALL,
                includeExecutionData: true,
            },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        logGroup.grantWrite(stateMachine.role);

        const api = new apigateway.RestApi(this, 'StepFuncApi', {
            restApiName: `StepFuncApi-${this.account}-${this.region}`,
            description: 'Step Functions Express API',
            endpointTypes: [apigateway.EndpointType.REGIONAL],
        });

        const apiKey = api.addApiKey('ApiKey');
        const usagePlan = api.addUsagePlan('UsagePlan', {
            apiStages: [{ api, stage: api.deploymentStage }],
        });
        usagePlan.addApiKey(apiKey);

        const orders = api.root.addResource('orders');
        orders.addMethod('GET', apigateway.StepFunctionsIntegration.startExecution(stateMachine), {
            apiKeyRequired: true,
        });

        StackUtils.exportStack(this, 'StateMachineName', stateMachine.stateMachineName, 'Express State Machine name');
        StackUtils.exportStack(this, 'StateMachineArn', stateMachine.stateMachineArn, 'Express State Machine ARN');
        StackUtils.exportStack(this, 'ApiEndpoint', api.url, 'API Gateway endpoint URL');
        StackUtils.exportStack(this, 'ApiId', api.restApiId, 'API Gateway REST API ID');
        StackUtils.exportStack(this, 'LogGroupName', logGroup.logGroupName, 'State Machine log group name');
    }
}
