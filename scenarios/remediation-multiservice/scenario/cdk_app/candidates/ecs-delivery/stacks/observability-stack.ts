import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { StackUtils } from '../lib/shared';
import { NAMES } from './names';

export interface ObservabilityStackProps extends cdk.StackProps {
    readonly vpc: ec2.Vpc;
    readonly registryTable: dynamodb.Table;
    readonly albDnsName: string;
    readonly targetGroupFullName: string;
    readonly loadBalancerFullName: string;
}

const AUDIT_CODE = [
    'import json, os, time',
    'import boto3',
    '',
    'ddb = boto3.client("dynamodb")',
    'ecr = boto3.client("ecr")',
    'TABLE = os.environ["REGISTRY_TABLE"]',
    'REPOS = [r for r in os.environ["REPOSITORIES"].split(",") if r]',
    'PIN_KEYS = [k for k in os.environ["PIN_KEYS"].split(",") if k]',
    '',
    '',
    'def handler(event, context):',
    '    scan_errors = 0',
    '    for repo in REPOS:',
    '        try:',
    '            images = ecr.describe_images(repositoryName=repo, maxResults=100)["imageDetails"]',
    '        except Exception as exc:',
    '            print("ERROR describe_images repository=%s: %s" % (repo, exc))',
    '            continue',
    '        print("audited repository=%s images=%d" % (repo, len(images)))',
    '        for detail in images[:3]:',
    '            digest = detail["imageDigest"]',
    '            try:',
    '                res = ecr.describe_image_scan_findings(repositoryName=repo, imageId={"imageDigest": digest})',
    '                print("scan repository=%s digest=%s status=%s" % (repo, digest, res["imageScanStatus"]["status"]))',
    '            except Exception as exc:',
    '                scan_errors += 1',
    '                print("ERROR scan findings unavailable repository=%s digest=%s: %s" % (repo, digest, exc))',
    '    missing = []',
    '    for key in PIN_KEYS:',
    '        items = ddb.query(',
    '            TableName=TABLE,',
    '            KeyConditionExpression="pk = :p",',
    '            ExpressionAttributeValues={":p": {"S": key}},',
    '        ).get("Items", [])',
    '        for item in items:',
    '            digest = item.get("imageDigest", {}).get("S")',
    '            repo = item.get("repository", {}).get("S")',
    '            if not digest or not repo:',
    '                continue',
    '            try:',
    '                ecr.describe_images(repositoryName=repo, imageIds=[{"imageDigest": digest}])',
    '            except ecr.exceptions.ImageNotFoundException:',
    '                missing.append({"repository": repo, "digest": digest, "pin": item.get("sk", {}).get("S")})',
    '                print("reconcile discrepancy for pin=%s repository=%s digest=%s" % (item.get("sk", {}).get("S"), repo, digest))',
    '            except Exception as exc:',
    '                print("ERROR reconcile repository=%s digest=%s: %s" % (repo, digest, exc))',
    '    ddb.put_item(TableName=TABLE, Item={',
    '        "pk": {"S": "channel:D91E"},',
    '        "sk": {"S": str(int(time.time()))},',
    '        "missingPinnedImages": {"S": json.dumps(missing)},',
    '        "scanAccessErrors": {"N": str(scan_errors)},',
    '    })',
    '    print("audit complete missing=%d scan_errors=%d" % (len(missing), scan_errors))',
    '    return {"missingPinnedImages": missing, "scanAccessErrors": scan_errors}',
].join('\n');

const PROBE_CODE = [
    'import os, urllib.request',
    '',
    'URL = os.environ["PROBE_URL"]',
    '',
    '',
    'def handler(event, context):',
    '    codes = []',
    '    for attempt in range(5):',
    '        try:',
    '            with urllib.request.urlopen(URL, timeout=5) as resp:',
    '                body = resp.read(32).decode("utf-8", "replace")',
    '                codes.append(resp.status)',
    '                print("probe attempt=%d status=%d body=%s" % (attempt, resp.status, body.strip()))',
    '        except Exception as exc:',
    '            codes.append(0)',
    '            print("probe attempt=%d failed: %s" % (attempt, exc))',
    '    ok = len([c for c in codes if c == 200])',
    '    print("probe summary url=%s ok=%d of %d" % (URL, ok, len(codes)))',
    '    if ok == 0:',
    '        raise RuntimeError("checkout-api is not answering through the internal ALB: %s" % URL)',
    '    return {"ok": ok, "codes": codes}',
].join('\n');

/**
 * Delivery observability: the ECR image auditor, the in-VPC synthetic probe that
 * exercises checkout-api through the internal ALB, and the alarms the on-call
 * engineer sees.
 */
export class ObservabilityStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
        super(scope, id, props);

        // ------------------------------------------------------------------
        // ECR image auditor
        // ------------------------------------------------------------------
        const auditLogGroup = new logs.LogGroup(this, 'AuditLogGroup', {
            logGroupName: `/aws/lambda/${NAMES.auditFunction}`,
            retention: logs.RetentionDays.THREE_DAYS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const auditFn = new lambda.Function(this, 'ImageAuditFn', {
            functionName: NAMES.auditFunction,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromInline(AUDIT_CODE),
            timeout: cdk.Duration.seconds(120),
            memorySize: 256,
            logGroup: auditLogGroup,
            description: 'Reconciles pinned deployment image digests against ECR and reports scan status',
            environment: {
                REGISTRY_TABLE: NAMES.registryTable,
                REPOSITORIES: `${NAMES.apiRepo},${NAMES.workerRepo}`,
                PIN_KEYS: 'channel:F52A',
            },
        });

        // Scoped ECR read access. ecr:DescribeImageScanFindings is deliberately NOT
        // granted.
        auditFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['ecr:DescribeImages', 'ecr:ListImages', 'ecr:DescribeRepositories', 'ecr:BatchGetImage'],
            resources: [
                `arn:${this.partition}:ecr:${this.region}:${this.account}:repository/${NAMES.apiRepo}`,
                `arn:${this.partition}:ecr:${this.region}:${this.account}:repository/${NAMES.workerRepo}`,
            ],
        }));
        props.registryTable.grantReadWriteData(auditFn);

        new logs.MetricFilter(this, 'AuditErrorFilter', {
            logGroup: auditLogGroup,
            filterPattern: logs.FilterPattern.literal('"ERROR scan findings unavailable"'),
            metricNamespace: 'Checkout/Delivery',
            metricName: 'ImageAuditAccessErrors',
            metricValue: '1',
            defaultValue: 0,
        });

        new cloudwatch.Alarm(this, 'AuditErrorAlarm', {
            alarmName: NAMES.auditAlarm,
            alarmDescription: 'checkout-api ECR image audit is reporting access errors',
            metric: new cloudwatch.Metric({
                namespace: 'Checkout/Delivery',
                metricName: 'ImageAuditAccessErrors',
                statistic: 'Sum',
                period: cdk.Duration.minutes(1),
            }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        // ------------------------------------------------------------------
        // In-VPC synthetic probe against the internal ALB
        // ------------------------------------------------------------------
        const probeSg = new ec2.SecurityGroup(this, 'ProbeSg', {
            vpc: props.vpc,
            securityGroupName: 'checkout-probe-sg',
            description: 'Synthetic probe Lambda - egress to the internal ALB',
            allowAllOutbound: true,
        });

        const probeLogGroup = new logs.LogGroup(this, 'ProbeLogGroup', {
            logGroupName: `/aws/lambda/${NAMES.probeFunction}`,
            retention: logs.RetentionDays.THREE_DAYS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        new lambda.Function(this, 'SyntheticProbeFn', {
            functionName: NAMES.probeFunction,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromInline(PROBE_CODE),
            timeout: cdk.Duration.seconds(60),
            memorySize: 128,
            logGroup: probeLogGroup,
            description: 'Calls checkout-api /health through the internal ALB',
            vpc: props.vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            securityGroups: [probeSg],
            environment: {
                PROBE_URL: `http://${props.albDnsName}/health`,
            },
        });

        // ------------------------------------------------------------------
        // Traffic health alarm
        // ------------------------------------------------------------------
        new cloudwatch.Alarm(this, 'UnhealthyHostAlarm', {
            alarmName: NAMES.unhealthyAlarm,
            alarmDescription: 'checkout-api has unhealthy targets behind the internal ALB',
            metric: new cloudwatch.Metric({
                namespace: 'AWS/ApplicationELB',
                metricName: 'UnHealthyHostCount',
                statistic: 'Maximum',
                period: cdk.Duration.minutes(1),
                dimensionsMap: {
                    TargetGroup: props.targetGroupFullName,
                    LoadBalancer: props.loadBalancerFullName,
                },
            }),
            threshold: 1,
            evaluationPeriods: 2,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        StackUtils.exportStack(this, 'AuditFunctionName', NAMES.auditFunction, 'ECR image audit Lambda');
        StackUtils.exportStack(this, 'ProbeFunctionName', NAMES.probeFunction, 'Synthetic probe Lambda for checkout-api');
        StackUtils.exportStack(this, 'AuditAlarmName', NAMES.auditAlarm, 'Alarm fed by the image audit error metric filter');
    }
}
