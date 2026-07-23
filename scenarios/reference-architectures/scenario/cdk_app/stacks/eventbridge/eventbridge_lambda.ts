import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * EventBridge Lambda Stack
 *
 * Converted from aws-cdk-examples/typescript/eventbridge-lambda
 *
 * Creates:
 * 1. SNS Topic for Lambda to publish messages to
 * 2. Lambda Function that publishes to the SNS topic
 * 3. EventBridge Rule on a cron schedule (every minute)
 * 4. Lambda target for the EventBridge rule
 */

export class EventbridgeLambdaStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // SNS Topic
        const topic = new sns.Topic(this, 'LambdaSNSTopic', {
            displayName: 'Lambda SNS Topic',
            topicName: `eventbridge-lambda-topic-${this.account}-${this.region}`,
        });
        topic.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Lambda Function
        const fn = new lambda.Function(this, 'EventBridgeLambdaFunction', {
            runtime: lambda.Runtime.PYTHON_3_9,
            handler: 'index.main',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/eventbridge-sns-publish')),
            environment: {
                TOPIC_ARN: topic.topicArn,
            },
            timeout: cdk.Duration.seconds(30),
        });

        // Grant Lambda SNS publish permissions
        topic.grantPublish(fn);

        // EventBridge Rule - every minute
        const rule = new events.Rule(this, 'EveryMinuteRule', {
            ruleName: `eventbridge-lambda-rule-${this.account}-${this.region}`,
            schedule: events.Schedule.expression('cron(* * ? * * *)'),
            description: 'Trigger Lambda function every minute',
        });

        // Add Lambda as target
        rule.addTarget(new targets.LambdaFunction(fn));

        // Exports
        StackUtils.exportStack(this, 'TopicArn', topic.topicArn, 'SNS topic ARN');
        StackUtils.exportStack(this, 'TopicName', topic.topicName, 'SNS topic name');
        StackUtils.exportStack(this, 'FunctionName', fn.functionName, 'Lambda function name');
        StackUtils.exportStack(this, 'FunctionArn', fn.functionArn, 'Lambda function ARN');
        StackUtils.exportStack(this, 'RuleName', rule.ruleName, 'EventBridge rule name');
        StackUtils.exportStack(this, 'RuleArn', rule.ruleArn, 'EventBridge rule ARN');
        StackUtils.exportStack(this, 'ScheduleExpression', 'cron(* * ? * * *)', 'EventBridge schedule expression');
    }
}
