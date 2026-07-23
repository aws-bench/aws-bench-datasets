import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Lambda CloudWatch Dashboard Stack
 *
 * Converted from aws-cdk-examples/typescript/lambda-cloudwatch-dashboard
 *
 * Creates:
 * 1. Lambda Function (Python 3.12) — sample function that generates metrics
 * 2. CloudWatch Dashboard with widgets:
 *    - Title text widget
 *    - Invocations graph
 *    - Errors graph
 *    - Duration graph
 *    - Throttles graph
 *    - Log query widget (last 20 entries)
 */

export class CloudwatchDashboardStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const dashboardName = `lambda-dashboard-${this.account}-${this.region}`;

        const lambdaFunction = new lambda.Function(this, 'SampleLambda', {
            functionName: `dashboard-sample-${this.account}-${this.region}`,
            handler: 'index.handler',
            runtime: lambda.Runtime.PYTHON_3_12,
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/cloudwatch-dashboard-sample')),
            memorySize: 512,
            timeout: cdk.Duration.seconds(10),
        });

        const dashboard = new cloudwatch.Dashboard(this, 'LambdaDashboard', {
            dashboardName,
        });

        dashboard.addWidgets(new cloudwatch.TextWidget({
            markdown: `# Dashboard: ${lambdaFunction.functionName}`,
            height: 1,
            width: 24,
        }));

        dashboard.addWidgets(new cloudwatch.GraphWidget({
            title: 'Invocations',
            left: [lambdaFunction.metricInvocations()],
            width: 24,
        }));

        dashboard.addWidgets(new cloudwatch.GraphWidget({
            title: 'Errors',
            left: [lambdaFunction.metricErrors()],
            width: 24,
        }));

        dashboard.addWidgets(new cloudwatch.GraphWidget({
            title: 'Duration',
            left: [lambdaFunction.metricDuration()],
            width: 24,
        }));

        dashboard.addWidgets(new cloudwatch.GraphWidget({
            title: 'Throttles',
            left: [lambdaFunction.metricThrottles()],
            width: 24,
        }));

        dashboard.addWidgets(new cloudwatch.LogQueryWidget({
            logGroupNames: [lambdaFunction.logGroup.logGroupName],
            queryLines: [
                'fields @timestamp, @message',
                'sort @timestamp desc',
                'limit 20',
            ],
            width: 24,
        }));

        StackUtils.exportStack(this, 'DashboardName', dashboardName, 'CloudWatch Dashboard name');
        StackUtils.exportStack(this, 'DashboardArn', dashboard.dashboardArn, 'CloudWatch Dashboard ARN');
        StackUtils.exportStack(this, 'FunctionName', lambdaFunction.functionName, 'Sample Lambda function name');
        StackUtils.exportStack(this, 'FunctionArn', lambdaFunction.functionArn, 'Sample Lambda function ARN');
    }
}
