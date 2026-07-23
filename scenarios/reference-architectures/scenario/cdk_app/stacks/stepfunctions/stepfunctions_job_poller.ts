import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: stepfunctions_job_poller
 *
 * What the stack does:
 * Converted from aws-cdk-examples/typescript/stepfunctions-job-poller.
 * Creates a Step Functions state machine that submits a job, waits, checks status,
 * and branches on success or failure. Triggered by an EventBridge cron rule.
 *
 * Resources created:
 * 1. Lambda "SubmitJob" function (Python 3.9)
 * 2. Lambda "CheckStatus" function (Python 3.9)
 * 3. Step Functions State Machine with submit -> wait -> check -> choice flow
 * 4. EventBridge Rule with weekday cron schedule
 * 5. EventBridge target linking the rule to the state machine
 */

export class StepFunctionsJobPoller extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // Lambda: Submit Job
        const submitJobFn = new lambda.Function(this, 'SubmitJobFunction', {
            functionName: `SubmitJob-${this.account}-${this.region}`,
            runtime: lambda.Runtime.PYTHON_3_9,
            handler: 'index.main',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/stepfunctions-submit-job')),
            timeout: cdk.Duration.seconds(30),
            description: 'Lambda function to submit a job',
        });

        // Lambda: Check Status
        const checkStatusFn = new lambda.Function(this, 'CheckStatusFunction', {
            functionName: `CheckStatus-${this.account}-${this.region}`,
            runtime: lambda.Runtime.PYTHON_3_9,
            handler: 'index.main',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/stepfunctions-check-status')),
            timeout: cdk.Duration.seconds(30),
            description: 'Lambda function to check job status',
        });

        // Step Functions: Define states
        const submitJob = new tasks.LambdaInvoke(this, 'SubmitJob', {
            lambdaFunction: submitJobFn,
            outputPath: '$.Payload',
        });

        const waitStep = new sfn.Wait(this, 'Wait30Seconds', {
            time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
        });

        const checkStatus = new tasks.LambdaInvoke(this, 'CheckStatus', {
            lambdaFunction: checkStatusFn,
            outputPath: '$.Payload',
        });

        const jobFailed = new sfn.Fail(this, 'JobFailed', {
            cause: 'AWS Batch Job Failed',
            error: 'DescribeJob returned FAILED',
        });

        const finalStatus = new tasks.LambdaInvoke(this, 'GetFinalJobStatus', {
            lambdaFunction: checkStatusFn,
            outputPath: '$.Payload',
        });

        // Chain: submit -> wait -> check -> choice
        const definition = submitJob
            .next(waitStep)
            .next(checkStatus)
            .next(new sfn.Choice(this, 'JobComplete')
                .when(sfn.Condition.stringEquals('$.status', 'FAILED'), jobFailed)
                .when(sfn.Condition.stringEquals('$.status', 'SUCCEEDED'), finalStatus)
                .otherwise(waitStep));

        // State Machine
        const stateMachine = new sfn.StateMachine(this, 'JobPollerStateMachine', {
            stateMachineName: `JobPoller-${this.account}-${this.region}`,
            definitionBody: sfn.DefinitionBody.fromChainable(definition),
            timeout: cdk.Duration.seconds(300),
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // EventBridge Rule with cron schedule (Mon-Fri at 6pm UTC)
        const rule = new events.Rule(this, 'JobPollerCronRule', {
            ruleName: `JobPollerRule-${this.account}-${this.region}`,
            description: 'EventBridge rule to trigger job poller state machine on weekdays',
            schedule: events.Schedule.expression('cron(0 18 ? * MON-FRI *)'),
            enabled: true,
        });

        // Add State Machine as target for the EventBridge rule
        rule.addTarget(new targets.SfnStateMachine(stateMachine));

        // Stack Exports
        StackUtils.exportStack(
            this,
            'StateMachineName',
            stateMachine.stateMachineName,
            'Name of the job poller state machine',
        );

        StackUtils.exportStack(
            this,
            'StateMachineArn',
            stateMachine.stateMachineArn,
            'ARN of the job poller state machine',
        );

        StackUtils.exportStack(
            this,
            'SubmitJobFunctionName',
            submitJobFn.functionName,
            'Name of the submit job Lambda function',
        );

        StackUtils.exportStack(
            this,
            'CheckStatusFunctionName',
            checkStatusFn.functionName,
            'Name of the check status Lambda function',
        );

        StackUtils.exportStack(
            this,
            'RuleName',
            rule.ruleName,
            'Name of the EventBridge cron rule',
        );

        StackUtils.exportStack(
            this,
            'StateMachineTimeout',
            '300',
            'Timeout in seconds for the state machine execution',
        );
    }
}
