import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack: ApiGatewayParallelStepFunctions
 *
 * Converted from aws-cdk-examples/typescript/api-gateway-parallel-step-functions.
 * SECURITY FIX: added API key authentication.
 *
 * Resources created:
 * 1. VPC (10.0.0.0/16, 2 AZs, public + private isolated subnets)
 * 2. Lambda 1 (Hello World - instant response)
 * 3. Lambda 2 (Hello World - 5s delay)
 * 4. Step Functions Parallel state with two branches
 * 5. Pass state to merge results
 * 6. Express State Machine with CloudWatch logging
 * 7. StepFunctionsRestApi (API Gateway) with API key auth
 * 8. API Key + Usage Plan
 */

export class ApiGatewayParallelStepFunctions extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // VPC
        const vpc = new ec2.Vpc(this, 'ParallelSfnVpc', {
            ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
                {
                    cidrMask: 24,
                    name: 'PrivateIsolated',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                },
            ],
        });

        // Lambda 1: Hello World (instant), in VPC private isolated subnet
        const helloFunction = new lambda.Function(this, 'HelloFunction', {
            runtime: lambda.Runtime.NODEJS_20_X,
            vpc: vpc,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            },
            handler: 'index.main',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/apigateway-parallel-hello')),
            timeout: cdk.Duration.seconds(30),
            description: 'Hello World Lambda - instant response',
        });

        // Lambda 2: Hello World (5s delay), in VPC private isolated subnet
        const sleepyFunction = new lambda.Function(this, 'SleepyFunction', {
            runtime: lambda.Runtime.NODEJS_20_X,
            vpc: vpc,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            },
            handler: 'index.main',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/apigateway-parallel-sleepy')),
            timeout: cdk.Duration.seconds(30),
            description: 'Hello World Lambda - 5 second delay',
        });

        // Step Functions tasks
        const invokeHello = new tasks.LambdaInvoke(this, 'InvokeHello', {
            lambdaFunction: helloFunction,
        });

        const invokeSleepy = new tasks.LambdaInvoke(this, 'InvokeSleepy', {
            lambdaFunction: sleepyFunction,
        });

        // Parallel state with two branches
        const parallel = new sfn.Parallel(this, 'ParallelExecution', {
            resultPath: '$.CombinedOutput',
        });
        parallel.branch(invokeHello);
        parallel.branch(invokeSleepy);

        // Pass state to merge parallel results with parameter reshaping
        const mergeResults = new sfn.Pass(this, 'MergeResults', {
            parameters: {
                'normal.$': '$.CombinedOutput[0].Payload.body',
                'fast.$': '$.CombinedOutput[1].Payload.body',
            },
        });

        // Chain: parallel -> merge
        const definition = parallel.next(mergeResults);

        // CloudWatch Log Group for State Machine
        const logGroup = new logs.LogGroup(this, 'ParallelSfnLogGroup', {
            logGroupName: `/aws/vendedlogs/states/parallel-sfn-${this.account}-${this.region}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Express State Machine with CloudWatch logging
        const stateMachine = new sfn.StateMachine(this, 'ParallelStateMachine', {
            definitionBody: sfn.DefinitionBody.fromChainable(definition),
            stateMachineType: sfn.StateMachineType.EXPRESS,
            timeout: cdk.Duration.minutes(5),
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            logs: {
                destination: logGroup,
                level: sfn.LogLevel.ALL,
                includeExecutionData: true,
            },
        });

        // StepFunctionsRestApi (API Gateway that invokes state machine)
        const api = new apigateway.StepFunctionsRestApi(this, 'ParallelSfnApi', {
            stateMachine,
            deploy: true,
            deployOptions: {
                stageName: 'dev',
            },
            apiKeySourceType: apigateway.ApiKeySourceType.HEADER,
            defaultMethodOptions: {
                apiKeyRequired: true,
            },
        });

        // API Key + Usage Plan
        const apiKey = api.addApiKey('ParallelSfnApiKey');
        const usagePlan = api.addUsagePlan('ParallelSfnUsagePlan', {
            name: 'ParallelSfnUsagePlan',
            throttle: {
                rateLimit: 10,
                burstLimit: 5,
            },
        });
        usagePlan.addApiKey(apiKey);
        usagePlan.addApiStage({ stage: api.deploymentStage });

        // /messages resource with GET method
        const messages = api.root.addResource('messages');
        messages.addMethod('GET', undefined, { apiKeyRequired: true });

        // Exports
        StackUtils.exportStack(this, 'StateMachineName', stateMachine.stateMachineName, 'Step Functions state machine name');
        StackUtils.exportStack(this, 'StateMachineArn', stateMachine.stateMachineArn, 'Step Functions state machine ARN');
        StackUtils.exportStack(this, 'StateMachineType', 'EXPRESS', 'State machine type');
        StackUtils.exportStack(this, 'Lambda1FunctionName', helloFunction.functionName, 'Hello World Lambda function name');
        StackUtils.exportStack(this, 'Lambda2FunctionName', sleepyFunction.functionName, 'Sleepy Lambda function name');
        StackUtils.exportStack(this, 'ApiEndpoint', api.url, 'API Gateway endpoint URL');
        StackUtils.exportStack(this, 'ApiId', api.restApiId, 'API Gateway REST API ID');
        StackUtils.exportStack(this, 'ApiKeyId', apiKey.keyId, 'API Key ID');
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'VPC ID');
    }
}
