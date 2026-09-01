import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { StackUtils } from '../lib/shared';

const P = 'ordpipe';

export interface PlatformGuardrailStackProps extends cdk.StackProps {
    /** Physical name of the order ingest queue (governed consumer). */
    readonly ordersQueueName: string;
    /** Physical name of the settlement queue (governed consumer). */
    readonly paymentsQueueName: string;
}

/**
 * Platform capacity policy stack owned by the shared platform team.
 *
 * A scheduled worker compares the SQS poller scaling ceiling of every
 * governed consumer against the authoritative capacity policy document held
 * in Parameter Store and puts back anything that drifted, recording the
 * correction in an audit table. Application teams therefore cannot make a
 * MaximumConcurrency change stick by editing the event source mapping alone.
 */
export class PlatformGuardrailStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: PlatformGuardrailStackProps) {
        super(scope, id, props);

        // Bind the props to locals so every export below is a literal string.
        const governedOrdersQueueName: string = props.ordersQueueName;
        const governedPaymentsQueueName: string = props.paymentsQueueName;

        const auditTableName = `${P}-platform-config-audit`;
        const auditTable = new dynamodb.Table(this, 'GuardrailAudit', {
            tableName: auditTableName,
            partitionKey: { name: 'resource', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'observed_at_ms', type: dynamodb.AttributeType.NUMBER },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Approved poller concurrency ceilings. The ingest queue is pinned to 3
        // by a capacity review that predates the multi line item fan out; the
        // settlement queue ceiling matches the value its mapping already uses.
        const ceilingsDoc = {
            version: 7,
            enabled: true,
            owner: 'platform-engineering',
            owner_ref: 'PLT-CAP-004',
            ceilings: {
                [governedOrdersQueueName]: 3,
                [governedPaymentsQueueName]: 5,
            },
            governed_targets: {
                [governedOrdersQueueName]: 'ordpipe-order-processor',
                [governedPaymentsQueueName]: 'ordpipe-payment-settler',
            },
        };

        const ceilingsParamName = `/${P}/platform/capacity-policy-registry`;
        const ceilingsParam = new ssm.StringParameter(this, 'CeilingsParam', {
            parameterName: ceilingsParamName,
            stringValue: JSON.stringify(ceilingsDoc),
            tier: ssm.ParameterTier.STANDARD,
            description:
                'Consumer capacity policy authoritative document. Refer to platform SOP for schema.',
        });

        // Informational per-consumer SLO targets; no worker reads this document.
        const sloTargetsParamName = `/${P}/platform/consumer-slo-targets`;
        new ssm.StringParameter(this, 'ConsumerSloTargetsParam', {
            parameterName: sloTargetsParamName,
            stringValue: JSON.stringify({
                version: 3,
                owner: 'platform-engineering',
                notes: 'per-consumer p95 processing targets and headroom recommendations',
                targets: {
                    [governedOrdersQueueName]: {
                        p95_processing_ms: 4000,
                        recommended_headroom: 40,
                        recommended_headroom_note: 'informational only',
                    },
                    [governedPaymentsQueueName]: {
                        p95_processing_ms: 2500,
                        recommended_headroom: 20,
                        recommended_headroom_note: 'informational only',
                    },
                },
            }),
            tier: ssm.ParameterTier.STANDARD,
            description:
                'Informational per-consumer SLO targets and recommended headroom (not enforced).',
        });

        // Archived capacity review history: stale ceilings, read by no worker.
        const reviewHistoryParamName = `/${P}/platform/capacity-review-history`;
        new ssm.StringParameter(this, 'CapacityReviewHistoryParam', {
            parameterName: reviewHistoryParamName,
            stringValue: JSON.stringify({
                version: 4,
                enabled: false,
                owner: 'platform-engineering',
                archived_at: '2024-11-02',
                ceilings: {
                    [governedOrdersQueueName]: 12,
                    [governedPaymentsQueueName]: 5,
                },
                superseded_by: 'PLT-CAP-004',
            }),
            tier: ssm.ParameterTier.STANDARD,
            description:
                'Archived capacity review history document (superseded, informational only).',
        });

        const guardrailName = `${P}-platform-config-sync`;
        const guardrail = new lambda.Function(this, 'ConcurrencyGuardrail', {
            functionName: guardrailName,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../assets/platform_config_sync')),
            memorySize: 256,
            timeout: cdk.Duration.seconds(60),
            logGroup: new logs.LogGroup(this, 'ConcurrencyGuardrailLogs', {
                logGroupName: `/aws/lambda/${guardrailName}`,
                retention: logs.RetentionDays.TWO_WEEKS,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
            environment: {
                CEILINGS_PARAM: ceilingsParamName,
                AUDIT_TABLE: auditTableName,
            },
            description:
                'Reconciles SQS event source mapping scaling ceilings against the approved platform capacity policy document',
        });
        ceilingsParam.grantRead(guardrail);
        auditTable.grantWriteData(guardrail);
        // Event source mappings are identified by generated UUIDs, so the
        // worker needs account wide reach for these three read/write actions
        // only.
        guardrail.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'ReconcileEventSourceMappingScalingConfig',
                effect: iam.Effect.ALLOW,
                actions: [
                    'lambda:ListEventSourceMappings',
                    'lambda:GetEventSourceMapping',
                    'lambda:UpdateEventSourceMapping',
                ],
                resources: ['*'],
            }),
        );

        const guardrailRuleName = `${P}-platform-config-tick`;
        new events.Rule(this, 'GuardrailReconcileSchedule', {
            ruleName: guardrailRuleName,
            description:
                'Platform capacity policy tick every 5 minutes',
            schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
            enabled: true,
            targets: [new targets.LambdaFunction(guardrail, { retryAttempts: 1 })],
        });

        const guardrailErrorsAlarmName = `${P}-platform-config-sync-errors`;
        new cloudwatch.Alarm(this, 'GuardrailErrorsAlarm', {
            alarmName: guardrailErrorsAlarmName,
            metric: guardrail.metricErrors({
                period: cdk.Duration.minutes(15),
                statistic: 'Sum',
            }),
            threshold: 0,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            alarmDescription: 'Platform config sync worker is failing',
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        StackUtils.exportStack(
            this,
            'CeilingsParameterName',
            ceilingsParamName,
            'SSM parameter holding the approved poller concurrency ceilings',
        );
        StackUtils.exportStack(
            this,
            'GuardrailFunctionName',
            guardrailName,
            'Platform config sync worker function name',
        );
        StackUtils.exportStack(
            this,
            'GuardrailRuleName',
            guardrailRuleName,
            'EventBridge rule that runs the platform config sync worker',
        );
        StackUtils.exportStack(
            this,
            'GuardrailAuditTableName',
            auditTableName,
            'Platform config audit table name',
        );
        StackUtils.exportStack(
            this,
            'GuardrailErrorsAlarmName',
            guardrailErrorsAlarmName,
            'Platform config sync worker error alarm name',
        );
        StackUtils.exportStack(
            this,
            'GovernedOrdersQueueName',
            governedOrdersQueueName,
            'Order ingest queue name governed by the capacity policy document',
        );
        StackUtils.exportStack(
            this,
            'GovernedPaymentsQueueName',
            governedPaymentsQueueName,
            'Settlement queue name governed by the capacity policy document',
        );
        StackUtils.exportStack(
            this,
            'SloTargetsParameterName',
            sloTargetsParamName,
            'Informational SLO targets parameter',
        );
        StackUtils.exportStack(
            this,
            'CapacityReviewHistoryParameterName',
            reviewHistoryParamName,
            'Archived capacity review history parameter',
        );
    }
}
