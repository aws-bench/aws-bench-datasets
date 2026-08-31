import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { StackUtils } from '../lib/shared';

const EVENT_SOURCE = 'com.acme.fulfillment';
const METRIC_NAMESPACE = 'Acme/Fulfillment';

/** RuleTargetInput that binds a raw inputPathsMap and inputTemplate pair. */
class StringFieldTransformer extends events.RuleTargetInput {
    constructor(
        private readonly pathsMap: { [name: string]: string },
        private readonly template: string,
    ) {
        super();
    }

    public bind(_rule: events.IRule): events.RuleTargetInputProperties {
        return { inputPathsMap: this.pathsMap, inputTemplate: this.template };
    }
}

/** Build a flat, all-string input transformer from JSON paths plus constants. */
function flatTransformer(
    paths: { [payloadKey: string]: string },
    constants: { [payloadKey: string]: string } = {},
): events.RuleTargetInput {
    const pathsMap: { [name: string]: string } = {};
    const parts: string[] = [];
    for (const [key, jsonPath] of Object.entries(paths)) {
        pathsMap[key] = jsonPath;
        parts.push(`"${key}":"<${key}>"`);
    }
    for (const [key, value] of Object.entries(constants)) {
        parts.push(`"${key}":"${value}"`);
    }
    return new StringFieldTransformer(pathsMap, `{${parts.join(',')}}`);
}

/**
 * Order fulfillment event pipeline.
 *
 *   PutEvents -> fulfillment-events-prod bus
 *       |-- fulfillment-order-placed-rule    --(input transformer)--> processor Lambda
 *       |-- fulfillment-order-shipped-rule   --(input transformer)--> processor Lambda
 *       |-- fulfillment-order-returned-rule  --(input transformer)--> processor Lambda
 *       |-- fulfillment-audit-archive-rule   --------(raw event)----> CloudWatch Logs
 *       `-- fulfillment-legacy-shipped-rule  (disabled, retired v1 pipeline)
 *
 *   processor Lambda -> fulfillment-event-records (DynamoDB)
 *                    -> reads fulfillment-tier-policy for SLA hours
 *   fulfillment-event-records stream -> aggregator Lambda -> fulfillment-tier-summary
 *
 * A separate staging bus carries the same rule names for pre-production
 * validation and writes to its own table.
 */
export class FulfillmentPipelineStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // ------------------------------------------------------------------
        // Physical names (explicit literals: keeps `cdk deploy` re-entrant)
        // ------------------------------------------------------------------
        const prodBusName = 'fulfillment-events-prod';
        const stagingBusName = 'fulfillment-events-staging';

        const recordsTableName = 'fulfillment-event-records';
        const summaryTableName = 'fulfillment-tier-summary';
        const tierPolicyTableName = 'fulfillment-tier-policy';
        const stagingRecordsTableName = 'fulfillment-event-records-staging';

        const processorFnName = 'fulfillment-event-processor';
        const aggregatorFnName = 'fulfillment-tier-aggregator';
        const stagingProcessorFnName = 'fulfillment-event-processor-staging';

        const placedRuleName = 'fulfillment-order-placed-rule';
        const shippedRuleName = 'fulfillment-order-shipped-rule';
        const returnedRuleName = 'fulfillment-order-returned-rule';
        const auditRuleName = 'fulfillment-audit-archive-rule';
        const legacyRuleName = 'fulfillment-legacy-shipped-rule';
        const canaryRuleName = 'fulfillment-shipped-canary-rule';

        const archiveLogGroupName = '/aws/events/fulfillment-audit-archive';
        const canaryLogGroupName = '/aws/events/fulfillment-shipped-canary';
        const targetDlqName = 'fulfillment-eventbridge-target-dlq';

        const defaultsAlarmName = 'fulfillment-shipped-field-defaults-alarm';
        const errorsAlarmName = 'fulfillment-processor-errors-alarm';
        const dlqAlarmName = 'fulfillment-target-dlq-depth-alarm';

        // ------------------------------------------------------------------
        // Storage
        // ------------------------------------------------------------------
        const recordsTable = new dynamodb.Table(this, 'RecordsTable', {
            tableName: recordsTableName,
            partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'eventKey', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
            pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        recordsTable.addGlobalSecondaryIndex({
            indexName: 'byEventType',
            partitionKey: { name: 'eventType', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'occurredAt', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        const summaryTable = new dynamodb.Table(this, 'SummaryTable', {
            tableName: summaryTableName,
            partitionKey: { name: 'tier', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const tierPolicyTable = new dynamodb.Table(this, 'TierPolicyTable', {
            tableName: tierPolicyTableName,
            partitionKey: { name: 'tier', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const stagingRecordsTable = new dynamodb.Table(this, 'StagingRecordsTable', {
            tableName: stagingRecordsTableName,
            partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'eventKey', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // ------------------------------------------------------------------
        // Compute
        // ------------------------------------------------------------------
        const processorLogGroup = new logs.LogGroup(this, 'ProcessorLogGroup', {
            logGroupName: `/aws/lambda/${processorFnName}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const processor = new lambda.Function(this, 'Processor', {
            functionName: processorFnName,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../assets/processor')),
            timeout: cdk.Duration.seconds(30),
            memorySize: 256,
            logGroup: processorLogGroup,
            description: 'Persists enriched fulfillment event records (prod pipeline)',
            environment: {
                RECORDS_TABLE: recordsTableName,
                TIER_POLICY_TABLE: tierPolicyTableName,
                METRIC_NAMESPACE: METRIC_NAMESPACE,
                PROCESSOR_VERSION: '2.4.1',
                DEFAULT_CUSTOMER_TIER: 'STANDARD',
                DEFAULT_CUSTOMER_REGION: 'unknown',
                FALLBACK_SLA_HOURS: '72',
            },
        });
        recordsTable.grantWriteData(processor);
        tierPolicyTable.grantReadData(processor);
        processor.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['cloudwatch:PutMetricData'],
                resources: ['*'],
                conditions: { StringEquals: { 'cloudwatch:namespace': METRIC_NAMESPACE } },
            }),
        );

        const stagingProcessorLogGroup = new logs.LogGroup(this, 'StagingProcessorLogGroup', {
            logGroupName: `/aws/lambda/${stagingProcessorFnName}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const stagingProcessor = new lambda.Function(this, 'StagingProcessor', {
            functionName: stagingProcessorFnName,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../assets/processor')),
            timeout: cdk.Duration.seconds(30),
            memorySize: 256,
            logGroup: stagingProcessorLogGroup,
            description: 'Pre-production copy of the fulfillment event processor',
            environment: {
                RECORDS_TABLE: stagingRecordsTableName,
                TIER_POLICY_TABLE: tierPolicyTableName,
                METRIC_NAMESPACE: METRIC_NAMESPACE,
                PROCESSOR_VERSION: '2.5.0-rc1',
                DEFAULT_CUSTOMER_TIER: 'STANDARD',
                DEFAULT_CUSTOMER_REGION: 'unknown',
                FALLBACK_SLA_HOURS: '72',
            },
        });
        stagingRecordsTable.grantWriteData(stagingProcessor);
        tierPolicyTable.grantReadData(stagingProcessor);
        stagingProcessor.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['cloudwatch:PutMetricData'],
                resources: ['*'],
                conditions: { StringEquals: { 'cloudwatch:namespace': METRIC_NAMESPACE } },
            }),
        );

        const aggregatorLogGroup = new logs.LogGroup(this, 'AggregatorLogGroup', {
            logGroupName: `/aws/lambda/${aggregatorFnName}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const aggregator = new lambda.Function(this, 'Aggregator', {
            functionName: aggregatorFnName,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../assets/aggregator')),
            timeout: cdk.Duration.seconds(30),
            memorySize: 256,
            logGroup: aggregatorLogGroup,
            description: 'Rolls fulfillment records up per customer tier',
            environment: { SUMMARY_TABLE: summaryTableName },
        });
        summaryTable.grantReadWriteData(aggregator);
        aggregator.addEventSource(
            new DynamoEventSource(recordsTable, {
                startingPosition: lambda.StartingPosition.LATEST,
                batchSize: 25,
                maxBatchingWindow: cdk.Duration.seconds(5),
                retryAttempts: 3,
            }),
        );

        // ------------------------------------------------------------------
        // Event buses, delivery DLQ, audit archive
        // ------------------------------------------------------------------
        const prodBus = new events.EventBus(this, 'ProdBus', { eventBusName: prodBusName });
        const stagingBus = new events.EventBus(this, 'StagingBus', { eventBusName: stagingBusName });

        const targetDlq = new sqs.Queue(this, 'TargetDlq', {
            queueName: targetDlqName,
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            enforceSSL: true,
            retentionPeriod: cdk.Duration.days(14),
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const archiveLogGroup = new logs.LogGroup(this, 'AuditArchiveLogGroup', {
            logGroupName: archiveLogGroupName,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const canaryLogGroup = new logs.LogGroup(this, 'ShippedCanaryLogGroup', {
            logGroupName: canaryLogGroupName,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Canary observer sink: a plain SQS queue drained by an out-of-band tap. The
        // CDK CloudWatchLogGroup target restricts input transformers to
        // {timestamp, message}, which would drop the customer.* paths this rule
        // projects.
        const canarySink = new sqs.Queue(this, 'ShippedCanarySink', {
            queueName: `${canaryRuleName}-sink`,
            retentionPeriod: cdk.Duration.hours(1),
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const deliveryOpts = {
            deadLetterQueue: targetDlq,
            retryAttempts: 2,
            maxEventAge: cdk.Duration.hours(2),
        };

        // ------------------------------------------------------------------
        // OrderPlaced: detail carries customer.{tier,region}
        // ------------------------------------------------------------------
        const placedRule = new events.Rule(this, 'OrderPlacedRule', {
            ruleName: placedRuleName,
            eventBus: prodBus,
            description: 'Flatten OrderPlaced events for the fulfillment processor',
            eventPattern: { source: [EVENT_SOURCE], detailType: ['OrderPlaced'] },
        });
        placedRule.addTarget(
            new targets.LambdaFunction(processor, {
                ...deliveryOpts,
                event: flatTransformer(
                    {
                        orderId: '$.detail.orderId',
                        eventType: '$.detail-type',
                        occurredAt: '$.detail.occurredAt',
                        customerTier: '$.detail.customer.tier',
                        customerRegion: '$.detail.customer.region',
                        channel: '$.detail.channel',
                    },
                    { sourceRule: placedRuleName },
                ),
            }),
        );

        // ------------------------------------------------------------------
        // OrderShipped: detail carries enrollment.{tier,region} - NOT customer.*
        // ------------------------------------------------------------------
        const shippedRule = new events.Rule(this, 'OrderShippedRule', {
            ruleName: shippedRuleName,
            eventBus: prodBus,
            description: 'Flatten OrderShipped events for the fulfillment processor',
            eventPattern: { source: [EVENT_SOURCE], detailType: ['OrderShipped'] },
        });
        shippedRule.addTarget(
            new targets.LambdaFunction(processor, {
                ...deliveryOpts,
                event: flatTransformer(
                    {
                        orderId: '$.detail.orderId',
                        eventType: '$.detail-type',
                        occurredAt: '$.detail.occurredAt',
                        // intentional: broken by design - the shipping service emits the
                        // subscriber block under a nested `enrollment` subtree, so
                        // detail.customer.* never resolves for OrderShipped events.
                        // EventBridge silently drops unresolved JSONPath variables, so
                        // the processor receives an empty string for customerTier and
                        // falls back to STANDARD / 48h SLA.
                        customerTier: '$.detail.customer.tier',
                        customerRegion: '$.detail.customer.region',
                        carrier: '$.detail.carrier.name',
                        serviceLevel: '$.detail.carrier.serviceLevel',
                        destinationCountry: '$.detail.destination.country',
                        warehouseCode: '$.detail.warehouse.code',
                    },
                    { sourceRule: shippedRuleName },
                ),
            }),
        );

        // ------------------------------------------------------------------
        // OrderReturned: detail carries customer.{tier,region}. Variables are named
        // memberTier/memberRegion; the InputTemplate re-projects them onto the
        // customerTier/customerRegion keys.
        // ------------------------------------------------------------------
        const returnedRule = new events.Rule(this, 'OrderReturnedRule', {
            ruleName: returnedRuleName,
            eventBus: prodBus,
            description: 'Flatten OrderReturned events for the fulfillment processor',
            eventPattern: { source: [EVENT_SOURCE], detailType: ['OrderReturned'] },
        });
        returnedRule.addTarget(
            new targets.LambdaFunction(processor, {
                ...deliveryOpts,
                event: new StringFieldTransformer(
                    {
                        orderId: '$.detail.orderId',
                        eventType: '$.detail-type',
                        occurredAt: '$.detail.occurredAt',
                        memberTier: '$.detail.customer.tier',
                        memberRegion: '$.detail.customer.region',
                        returnReason: '$.detail.returnReason',
                        warehouseCode: '$.detail.warehouse.code',
                    },
                    // Note the template re-labels memberTier -> customerTier so
                    // the processor's field-defaults check reads them correctly.
                    '{'
                    + '"orderId":"<orderId>",'
                    + '"eventType":"<eventType>",'
                    + '"occurredAt":"<occurredAt>",'
                    + '"customerTier":"<memberTier>",'
                    + '"customerRegion":"<memberRegion>",'
                    + '"returnReason":"<returnReason>",'
                    + '"warehouseCode":"<warehouseCode>",'
                    + `"sourceRule":"${returnedRuleName}"`
                    + '}',
                ),
            }),
        );

        // ------------------------------------------------------------------
        // Audit archive: envelope-only projection. The raw detail block MUST NOT be
        // written to this log group.
        // ------------------------------------------------------------------
        const auditRule = new events.Rule(this, 'AuditArchiveRule', {
            ruleName: auditRuleName,
            eventBus: prodBus,
            description: 'Envelope-only audit archive (raw detail redacted by policy)',
            eventPattern: { source: [EVENT_SOURCE] },
        });
        auditRule.addTarget(
            new targets.CloudWatchLogGroup(archiveLogGroup, {
                logEvent: targets.LogGroupTargetInput.fromObject({
                    timestamp: events.EventField.fromPath('$.time'),
                    message: JSON.stringify({
                        source: events.EventField.fromPath('$.source'),
                        detailType: events.EventField.fromPath('$.detail-type'),
                        // orderId is a non-PII correlation id already exposed on
                        // dashboards; every other detail.* attribute is redacted.
                        orderId: events.EventField.fromPath('$.detail.orderId'),
                        ingestionMarker: 'AUDIT_ENVELOPE_ONLY',
                    }),
                }),
            }),
        );

        // ------------------------------------------------------------------
        // Shipped canary rule: a low-fidelity projection of the OrderShipped
        // stream onto its own SQS sink. Emits synthetic customer.* fields, is
        // never wired to the processor, and never touches DynamoDB.
        // ------------------------------------------------------------------
        const canaryRule = new events.Rule(this, 'ShippedCanaryRule', {
            ruleName: canaryRuleName,
            eventBus: prodBus,
            description: 'Log-only canary projection for OrderShipped events',
            eventPattern: { source: [EVENT_SOURCE], detailType: ['OrderShipped'] },
        });
        canaryRule.addTarget(
            new targets.SqsQueue(canarySink, {
                message: flatTransformer(
                    {
                        orderId: '$.detail.orderId',
                        eventType: '$.detail-type',
                        occurredAt: '$.detail.occurredAt',
                        customerTier: '$.detail.customer.tier',
                        customerRegion: '$.detail.customer.region',
                        carrier: '$.detail.carrier.name',
                    },
                    { sourceRule: canaryRuleName },
                ),
            }),
        );

        // ------------------------------------------------------------------
        // Retired v1 shipped projection, disabled.
        // ------------------------------------------------------------------
        const legacyRule = new events.Rule(this, 'LegacyShippedRule', {
            ruleName: legacyRuleName,
            eventBus: prodBus,
            enabled: false,
            description: 'Retired v1 shipped projection - disabled during the 2.x cutover',
            eventPattern: { source: [EVENT_SOURCE], detailType: ['OrderShipped'] },
        });
        legacyRule.addTarget(
            new targets.LambdaFunction(processor, {
                ...deliveryOpts,
                event: flatTransformer(
                    {
                        orderId: '$.detail.shipment.orderRef',
                        eventType: '$.detail-type',
                        occurredAt: '$.detail.shipment.stampedAt',
                        customerTier: '$.detail.shipment.tier',
                        customerRegion: '$.detail.shipment.region',
                    },
                    { sourceRule: legacyRuleName },
                ),
            }),
        );

        // ------------------------------------------------------------------
        // Staging bus: same rule name, paths matched to the shipped shape
        // ------------------------------------------------------------------
        const stagingShippedRule = new events.Rule(this, 'StagingOrderShippedRule', {
            ruleName: shippedRuleName,
            eventBus: stagingBus,
            description: 'Pre-production OrderShipped projection',
            eventPattern: { source: [EVENT_SOURCE], detailType: ['OrderShipped'] },
        });
        stagingShippedRule.addTarget(
            new targets.LambdaFunction(stagingProcessor, {
                ...deliveryOpts,
                event: flatTransformer(
                    {
                        orderId: '$.detail.orderId',
                        eventType: '$.detail-type',
                        occurredAt: '$.detail.occurredAt',
                        // Staging producers emit the subscriber block under
                        // detail.subscriber.* (the shipping team's 3.1
                        // pre-production schema); this rule mirrors that.
                        customerTier: '$.detail.subscriber.tier',
                        customerRegion: '$.detail.subscriber.region',
                        carrier: '$.detail.carrier.name',
                        serviceLevel: '$.detail.carrier.serviceLevel',
                        destinationCountry: '$.detail.destination.country',
                        warehouseCode: '$.detail.warehouse.code',
                    },
                    { sourceRule: shippedRuleName },
                ),
            }),
        );

        // ------------------------------------------------------------------
        // Observability
        // ------------------------------------------------------------------
        const defaultsMetric = new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'FieldDefaultsApplied',
            dimensionsMap: { EventType: 'OrderShipped' },
            statistic: 'Sum',
            period: cdk.Duration.minutes(1),
        });
        new cloudwatch.Alarm(this, 'DefaultsAlarm', {
            alarmName: defaultsAlarmName,
            alarmDescription:
                'Fulfillment processor substituted default values on OrderShipped records',
            metric: defaultsMetric,
            threshold: 1,
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.MISSING,
        });

        new cloudwatch.Alarm(this, 'ProcessorErrorsAlarm', {
            alarmName: errorsAlarmName,
            alarmDescription: 'fulfillment-event-processor invocation errors',
            metric: processor.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        new cloudwatch.Alarm(this, 'TargetDlqAlarm', {
            alarmName: dlqAlarmName,
            alarmDescription: 'EventBridge target delivery failures landing on the DLQ',
            metric: targetDlq.metricApproximateNumberOfMessagesVisible({
                period: cdk.Duration.minutes(5),
                statistic: 'Maximum',
            }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        new cloudwatch.Dashboard(this, 'PipelineDashboard', {
            dashboardName: 'fulfillment-event-pipeline',
            widgets: [
                [
                    new cloudwatch.GraphWidget({
                        title: 'Processor invocations vs errors',
                        left: [processor.metricInvocations(), processor.metricErrors()],
                    }),
                    new cloudwatch.GraphWidget({
                        title: 'Field defaults applied by event type',
                        left: [
                            defaultsMetric.with({ period: cdk.Duration.minutes(5) }),
                            new cloudwatch.Metric({
                                namespace: METRIC_NAMESPACE,
                                metricName: 'FieldDefaultsApplied',
                                dimensionsMap: { EventType: 'OrderPlaced' },
                                statistic: 'Sum',
                                period: cdk.Duration.minutes(5),
                            }),
                        ],
                    }),
                ],
            ],
        });

        // ------------------------------------------------------------------
        // Outputs
        // ------------------------------------------------------------------
        StackUtils.exportStack(this, 'ProdBusName', prodBusName, 'Production fulfillment event bus');
        StackUtils.exportStack(this, 'StagingBusName', stagingBusName, 'Staging fulfillment event bus');
        StackUtils.exportStack(this, 'PlacedRuleName', placedRuleName, 'OrderPlaced routing rule');
        StackUtils.exportStack(this, 'ShippedRuleName', shippedRuleName, 'OrderShipped routing rule');
        StackUtils.exportStack(this, 'ReturnedRuleName', returnedRuleName, 'OrderReturned routing rule');
        StackUtils.exportStack(this, 'AuditRuleName', auditRuleName, 'Envelope-only audit archive rule');
        StackUtils.exportStack(this, 'LegacyRuleName', legacyRuleName, 'Disabled v1 shipped rule');
        StackUtils.exportStack(this, 'CanaryRuleName', canaryRuleName, 'Log-only shipped canary rule');
        StackUtils.exportStack(this, 'CanaryLogGroupName', canaryLogGroupName, 'Canary observer log group');
        StackUtils.exportStack(this, 'ProcessorFunctionName', processorFnName, 'Prod processor Lambda');
        StackUtils.exportStack(this, 'StagingProcessorFunctionName', stagingProcessorFnName, 'Staging processor Lambda');
        StackUtils.exportStack(this, 'AggregatorFunctionName', aggregatorFnName, 'Tier summary aggregator Lambda');
        StackUtils.exportStack(this, 'RecordsTableName', recordsTableName, 'Enriched fulfillment records');
        StackUtils.exportStack(this, 'SummaryTableName', summaryTableName, 'Per-tier rollup table');
        StackUtils.exportStack(this, 'TierPolicyTableName', tierPolicyTableName, 'Tier SLA policy table');
        StackUtils.exportStack(this, 'StagingRecordsTableName', stagingRecordsTableName, 'Staging records table');
        StackUtils.exportStack(this, 'ArchiveLogGroupName', archiveLogGroupName, 'Envelope-only audit archive log group');
        StackUtils.exportStack(this, 'ProcessorLogGroupName', `/aws/lambda/${processorFnName}`, 'Processor log group');
        StackUtils.exportStack(this, 'TargetDlqName', targetDlqName, 'EventBridge target DLQ');
        StackUtils.exportStack(this, 'DefaultsAlarmName', defaultsAlarmName, 'Field-defaults alarm');
        StackUtils.exportStack(this, 'ErrorsAlarmName', errorsAlarmName, 'Processor errors alarm');
        StackUtils.exportStack(this, 'DlqAlarmName', dlqAlarmName, 'Target DLQ depth alarm');
        StackUtils.exportStack(this, 'MetricNamespace', METRIC_NAMESPACE, 'Custom metric namespace');
        StackUtils.exportStack(this, 'EventSourceName', EVENT_SOURCE, 'Event source used by producers');
    }
}
