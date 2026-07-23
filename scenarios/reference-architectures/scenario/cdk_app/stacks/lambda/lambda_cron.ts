import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: lambda_cron
 *
 * What the stack does:
 * Converted from aws-cdk-examples/typescript/lambda-cron.
 * Creates an EventBridge rule on a cron schedule that triggers a Lambda function.
 *
 * Resources created:
 * 1. EventBridge Rule with weekday cron schedule (Mon-Fri at 6pm UTC)
 * 2. Lambda Function (Python 3.9) with inline handler
 * 3. EventBridge target linking the rule to the Lambda function
 */

export class LambdaCron extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // Lambda Function
        const lambdaFn = new lambda.Function(this, 'CronLambdaFunction', {
            functionName: `LambdaCron-${this.account}-${this.region}`,
            runtime: lambda.Runtime.PYTHON_3_9,
            handler: 'index.main',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/lambda-cron')),
            timeout: cdk.Duration.seconds(30),
            description: 'Lambda function triggered by EventBridge cron schedule',
        });

        // EventBridge Rule with cron schedule (Mon-Fri at 6pm UTC)
        const rule = new events.Rule(this, 'CronRule', {
            ruleName: `LambdaCronRule-${this.account}-${this.region}`,
            description: 'EventBridge rule to trigger Lambda on weekdays at 6pm UTC',
            schedule: events.Schedule.expression('cron(0 18 ? * MON-FRI *)'),
            enabled: true,
        });

        // Add Lambda as target for the EventBridge rule
        rule.addTarget(new targets.LambdaFunction(lambdaFn));

        // Stack Exports
        StackUtils.exportStack(
            this,
            'FunctionName',
            lambdaFn.functionName,
            'Name of the cron-triggered Lambda function',
        );

        StackUtils.exportStack(
            this,
            'FunctionArn',
            lambdaFn.functionArn,
            'ARN of the cron-triggered Lambda function',
        );

        StackUtils.exportStack(
            this,
            'RuleName',
            rule.ruleName,
            'Name of the EventBridge cron rule',
        );

        StackUtils.exportStack(
            this,
            'RuleArn',
            rule.ruleArn,
            'ARN of the EventBridge cron rule',
        );

        StackUtils.exportStack(
            this,
            'ScheduleExpression',
            'cron(0 18 ? * MON-FRI *)',
            'Cron schedule expression for the EventBridge rule',
        );
    }
}
