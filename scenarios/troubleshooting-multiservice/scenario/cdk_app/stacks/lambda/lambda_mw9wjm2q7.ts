import * as cdk from 'aws-cdk-lib';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

import { StackUtils } from '../../lib/shared';
import * as logs from 'aws-cdk-lib/aws-logs';

/*
 * Stack ID: lambda-mw9wjm2q7
 *
 * 0330c101-f9ad-4e1e-a49f-4599666da96b
 *
 * What the stack does:
 * 1. Creates a Lambda processing function
 * 2. Creates an IAM role for the state machine with permission to invoke the Lambda
 * 3. Creates a Step Functions state machine that invokes the Lambda
 */
export class Lambda_mw9wjm2q7 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const processingLambdaLogGroup = new logs.LogGroup(this, 'ProcessingLambdaLogGroup', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const processingLambda = new lambda.Function(this, 'ProcessingLambda', {
            logGroup: processingLambdaLogGroup,
            functionName: `ProcessingLambda-${this.account}-${this.region}`,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromInline(`
def handler(event, context):
    raise RuntimeError("Configuration validation failed: missing required field 'targetBucket'")
`),
        });

        const stateMachineRole = new iam.Role(this, 'StateMachineRole', {
            assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
        });
        processingLambda.grantInvoke(stateMachineRole);

        const stateMachine = new stepfunctions.StateMachine(this, 'QuartzConfigurationStateMachine', {
            stateMachineName: `QuartzConfigurationStateMachine-${this.account}-${this.region}`,
            definitionBody: stepfunctions.DefinitionBody.fromChainable(
                new tasks.LambdaInvoke(this, 'InvokeProcessingLambda', {
                    lambdaFunction: processingLambda,
                    retryOnServiceExceptions: false,
                }),
            ),
            role: stateMachineRole,
            stateMachineType: stepfunctions.StateMachineType.STANDARD,
        });

        StackUtils.exportStack(this, 'StateMachineArn', stateMachine.stateMachineArn, 'State machine ARN');
        StackUtils.exportStack(this, 'ProcessingLambdaArn', processingLambda.functionArn, 'Processing Lambda ARN');
    }
}
