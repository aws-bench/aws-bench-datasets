import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { StackUtils } from '../lib/shared';

const P = 'ordpipe';

/**
 * Order ingestion platform.
 *
 *   EventBridge (1/min) -> ingest-gateway -> SQS orders-ingest   -> order-processor:live -> DynamoDB
 *                                                                     `-> inventory-validator -> DynamoDB
 *                                                                  (staged, disabled) order-processor-express
 *                                        -> SQS notifications    -> notification-fanout -> DynamoDB
 *                                        -> SQS payments         -> payment-settler     -> DynamoDB
 *
 *   SQS orders-replay (redrive lane, normally empty) -> order-processor:live
 */
export class OrderIngestStack extends cdk.Stack {
    public readonly ordersQueueName: string;
    public readonly paymentsQueueName: string;
    public readonly processorFunctionName: string;

    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // ---------------------------------------------------------------- data
        const ordersTableName = `${P}-orders-processed`;
        const ordersTable = new dynamodb.Table(this, 'OrdersTable', {
            tableName: ordersTableName,
            partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const inventoryTableName = `${P}-inventory-catalog`;
        const inventoryTable = new dynamodb.Table(this, 'InventoryTable', {
            tableName: inventoryTableName,
            partitionKey: { name: 'sku', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const notificationsTableName = `${P}-notifications-audit`;
        const notificationsTable = new dynamodb.Table(this, 'NotificationsTable', {
            tableName: notificationsTableName,
            partitionKey: { name: 'notification_id', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'delivered_at_ms', type: dynamodb.AttributeType.NUMBER },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // ------------------------------------------------------- configuration
        const supplierLatencyParamName = `/${P}/inventory/supplier-latency-ms`;
        const supplierLatencyParam = new ssm.StringParameter(this, 'SupplierLatencyParam', {
            parameterName: supplierLatencyParamName,
            stringValue: '1800',
            description:
                'Round trip latency budget (ms) for the supplier availability call made per SKU',
            tier: ssm.ParameterTier.STANDARD,
        });

        // -------------------------------------------------------------- queues
        const ordersDlqName = `${P}-orders-ingest-dlq`;
        const ordersDlq = new sqs.Queue(this, 'OrdersDlq', {
            queueName: ordersDlqName,
            retentionPeriod: cdk.Duration.days(14),
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const ordersQueueName = `${P}-orders-ingest`;
        this.ordersQueueName = ordersQueueName;
        const ordersQueue = new sqs.Queue(this, 'OrdersQueue', {
            queueName: ordersQueueName,
            // 3x the consumer timeout (120s) - correct sizing for the consumer.
            visibilityTimeout: cdk.Duration.seconds(360),
            receiveMessageWaitTime: cdk.Duration.seconds(20),
            retentionPeriod: cdk.Duration.days(14),
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            enforceSSL: true,
            deadLetterQueue: { queue: ordersDlq, maxReceiveCount: 5 },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Redrive lane used when operations replay parked orders out of the DLQ.
        // Idle in steady state, but its mapping is live so a redrive starts
        // draining immediately.
        const replayQueueName = `${P}-orders-replay`;
        const replayQueue = new sqs.Queue(this, 'OrdersReplayQueue', {
            queueName: replayQueueName,
            visibilityTimeout: cdk.Duration.seconds(360),
            receiveMessageWaitTime: cdk.Duration.seconds(20),
            retentionPeriod: cdk.Duration.days(7),
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            enforceSSL: true,
            deadLetterQueue: { queue: ordersDlq, maxReceiveCount: 3 },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const notificationsDlqName = `${P}-notifications-dlq`;
        const notificationsDlq = new sqs.Queue(this, 'NotificationsDlq', {
            queueName: notificationsDlqName,
            retentionPeriod: cdk.Duration.days(14),
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const notificationsQueueName = `${P}-notifications`;
        const notificationsQueue = new sqs.Queue(this, 'NotificationsQueue', {
            queueName: notificationsQueueName,
            visibilityTimeout: cdk.Duration.seconds(180),
            receiveMessageWaitTime: cdk.Duration.seconds(20),
            retentionPeriod: cdk.Duration.days(7),
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            enforceSSL: true,
            deadLetterQueue: { queue: notificationsDlq, maxReceiveCount: 5 },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const paymentsDlqName = `${P}-payments-settlement-dlq`;
        const paymentsDlq = new sqs.Queue(this, 'PaymentsDlq', {
            queueName: paymentsDlqName,
            retentionPeriod: cdk.Duration.days(14),
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const paymentsQueueName = `${P}-payments-settlement`;
        this.paymentsQueueName = paymentsQueueName;
        const paymentsQueue = new sqs.Queue(this, 'PaymentsQueue', {
            queueName: paymentsQueueName,
            visibilityTimeout: cdk.Duration.seconds(180),
            receiveMessageWaitTime: cdk.Duration.seconds(20),
            retentionPeriod: cdk.Duration.days(7),
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            enforceSSL: true,
            deadLetterQueue: { queue: paymentsDlq, maxReceiveCount: 5 },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // ------------------------------------------------------------ compute
        const logGroupFor = (fnName: string, logicalId: string): logs.LogGroup =>
            new logs.LogGroup(this, logicalId, {
                logGroupName: `/aws/lambda/${fnName}`,
                retention: logs.RetentionDays.ONE_WEEK,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            });

        // Inventory validator: one synchronous supplier round trip per SKU.
        const validatorName = `${P}-inventory-validator`;
        const validator = new lambda.Function(this, 'InventoryValidator', {
            functionName: validatorName,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../assets/inventory_validator')),
            memorySize: 128,
            timeout: cdk.Duration.seconds(15),
            logGroup: logGroupFor(validatorName, 'InventoryValidatorLogs'),
            environment: {
                INVENTORY_TABLE: inventoryTableName,
                SUPPLIER_LATENCY_PARAM: supplierLatencyParamName,
                DEFAULT_SUPPLIER_LATENCY_MS: '1800',
            },
        });
        inventoryTable.grantReadData(validator);
        supplierLatencyParam.grantRead(validator);

        // Order processor: the SQS consumer under investigation. Traffic reaches
        // it through the `live` alias, which is what the event source mapping is
        // actually bound to.
        const processorName = `${P}-order-processor`;
        this.processorFunctionName = processorName;
        const processor = new lambda.Function(this, 'OrderProcessor', {
            functionName: processorName,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../assets/order_processor')),
            memorySize: 256,
            timeout: cdk.Duration.seconds(120),
            // Headroom above the poller ceiling: the function is never asked to
            // exceed this reservation, so Throttles stay 0.
            reservedConcurrentExecutions: 4,
            logGroup: logGroupFor(processorName, 'OrderProcessorLogs'),
            currentVersionOptions: {
                description: 'Order processor - line item validation via inventory service',
                removalPolicy: cdk.RemovalPolicy.RETAIN,
            },
            environment: {
                ORDERS_TABLE: ordersTableName,
                VALIDATOR_FUNCTION: validatorName,
            },
        });
        ordersTable.grantWriteData(processor);
        validator.grantInvoke(processor);

        const processorAliasName = 'live';
        const processorLive = new lambda.Alias(this, 'OrderProcessorLive', {
            aliasName: processorAliasName,
            version: processor.currentVersion,
            description: 'Production traffic pointer for the order processor',
            // Warm pool of two environments. It saturates and spills over to on-demand
            // concurrency, which shows up as a permanently breaching spillover alarm.
            provisionedConcurrentExecutions: 2,
        });

        // Express lane consumer: staged for cut over, its mapping is not enabled
        // yet, so it consumes nothing today.
        const expressName = `${P}-order-processor-express`;
        const express = new lambda.Function(this, 'OrderProcessorExpress', {
            functionName: expressName,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(
                path.join(__dirname, '../assets/order_processor_express'),
            ),
            memorySize: 512,
            timeout: cdk.Duration.seconds(60),
            logGroup: logGroupFor(expressName, 'OrderProcessorExpressLogs'),
            environment: {
                ORDERS_TABLE: ordersTableName,
                VALIDATOR_FUNCTION: validatorName,
                SAMPLE_SKUS_PER_ORDER: '1',
            },
        });
        ordersTable.grantWriteData(express);
        validator.grantInvoke(express);

        new lambda.EventSourceMapping(this, 'OrdersEventSourceLive', {
            target: processorLive,
            eventSourceArn: ordersQueue.queueArn,
            batchSize: 1,
            reportBatchItemFailures: true,
            // intentional: broken by design - the poller for this mapping never
            // asks Lambda for more than 3 concurrent invocations. Combined with
            // batchSize 1 and ~19s of work per message the ceiling puts maximum
            // drain throughput far below the arrival rate, and because the limit
            // is enforced by the poller (not by function concurrency) Lambda
            // records zero Throttles and zero Errors.
            maxConcurrency: 3,
            enabled: true,
        });
        ordersQueue.grantConsumeMessages(processor);

        // Express lane mapping: generous batching. The express function carries no
        // reserved concurrency, so its ceiling is unconstrained.
        new lambda.EventSourceMapping(this, 'OrdersEventSourceExpress', {
            target: express,
            eventSourceArn: ordersQueue.queueArn,
            batchSize: 10,
            maxBatchingWindow: cdk.Duration.seconds(5),
            reportBatchItemFailures: true,
            maxConcurrency: 40,
            enabled: false,
        });
        ordersQueue.grantConsumeMessages(express);

        // Redrive lane mapping: same consumer alias, sized to the consumer's
        // whole reservation (an event source mapping ceiling may not exceed the
        // target function's reserved concurrency) so a replay drains as fast as
        // the function is allowed to run. Live, but the replay queue is empty in
        // steady state.
        new lambda.EventSourceMapping(this, 'OrdersReplayEventSource', {
            target: processorLive,
            eventSourceArn: replayQueue.queueArn,
            batchSize: 10,
            maxBatchingWindow: cdk.Duration.seconds(5),
            reportBatchItemFailures: true,
            maxConcurrency: 4,
            enabled: true,
        });
        replayQueue.grantConsumeMessages(processor);

        // Analytics tap: independent lightweight consumer that samples ingest
        // traffic for downstream analytics. Runs on its own function via its
        // own alias, so it contends for nothing with the primary consumer.
        const analyticsTapName = `${P}-analytics-tap`;
        const analyticsTap = new lambda.Function(this, 'AnalyticsTap', {
            functionName: analyticsTapName,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../assets/analytics_tap')),
            memorySize: 128,
            timeout: cdk.Duration.seconds(15),
            logGroup: logGroupFor(analyticsTapName, 'AnalyticsTapLogs'),
        });
        const analyticsTapAliasName = 'live';
        const analyticsTapLive = new lambda.Alias(this, 'AnalyticsTapLive', {
            aliasName: analyticsTapAliasName,
            version: analyticsTap.currentVersion,
            description: 'Analytics tap live alias',
        });
        new lambda.EventSourceMapping(this, 'OrdersAnalyticsTapEventSource', {
            target: analyticsTapLive,
            eventSourceArn: ordersQueue.queueArn,
            batchSize: 5,
            maxBatchingWindow: cdk.Duration.seconds(5),
            reportBatchItemFailures: true,
            maxConcurrency: 10,
            enabled: true,
        });
        ordersQueue.grantConsumeMessages(analyticsTap);

        // Notification fan-out: healthy reference consumer (no scaling ceiling).
        const fanoutName = `${P}-notification-fanout`;
        const fanout = new lambda.Function(this, 'NotificationFanout', {
            functionName: fanoutName,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../assets/notification_fanout')),
            memorySize: 256,
            timeout: cdk.Duration.seconds(30),
            logGroup: logGroupFor(fanoutName, 'NotificationFanoutLogs'),
            environment: { NOTIFICATIONS_TABLE: notificationsTableName },
        });
        notificationsTable.grantWriteData(fanout);
        fanout.addEventSource(
            new sources.SqsEventSource(notificationsQueue, {
                batchSize: 10,
                maxBatchingWindow: cdk.Duration.seconds(5),
                reportBatchItemFailures: true,
            }),
        );

        // Payment settlement: healthy reference consumer that also uses reserved
        // concurrency, with a governed scaling ceiling that leaves real headroom.
        const settlerName = `${P}-payment-settler`;
        const settler = new lambda.Function(this, 'PaymentSettler', {
            functionName: settlerName,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../assets/payment_settler')),
            memorySize: 256,
            timeout: cdk.Duration.seconds(60),
            reservedConcurrentExecutions: 5,
            logGroup: logGroupFor(settlerName, 'PaymentSettlerLogs'),
            environment: { ORDERS_TABLE: ordersTableName },
        });
        ordersTable.grantWriteData(settler);
        settler.addEventSource(
            new sources.SqsEventSource(paymentsQueue, {
                batchSize: 5,
                maxBatchingWindow: cdk.Duration.seconds(5),
                reportBatchItemFailures: true,
                maxConcurrency: 5,
            }),
        );

        // Ingest gateway: storefront traffic generator, one batch per minute.
        const gatewayName = `${P}-ingest-gateway`;
        const gateway = new lambda.Function(this, 'IngestGateway', {
            functionName: gatewayName,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../assets/order_generator')),
            memorySize: 256,
            timeout: cdk.Duration.seconds(60),
            logGroup: logGroupFor(gatewayName, 'IngestGatewayLogs'),
            environment: {
                ORDERS_QUEUE_URL: ordersQueue.queueUrl,
                NOTIFICATIONS_QUEUE_URL: notificationsQueue.queueUrl,
                PAYMENTS_QUEUE_URL: paymentsQueue.queueUrl,
                ORDERS_PER_RUN: '20',
                NOTIFICATIONS_PER_RUN: '8',
                PAYMENTS_PER_RUN: '3',
                LINE_ITEMS_PER_ORDER: '10',
            },
        });
        ordersQueue.grantSendMessages(gateway);
        notificationsQueue.grantSendMessages(gateway);
        paymentsQueue.grantSendMessages(gateway);

        // Enumerates the publisher and the express lane consumer only; the live
        // consumer receives through its execution role's identity policy.
        ordersQueue.addToResourcePolicy(
            new iam.PolicyStatement({
                sid: 'AllowIngestGatewayPublish',
                effect: iam.Effect.ALLOW,
                principals: [gateway.role!],
                actions: ['sqs:SendMessage', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl'],
                resources: [ordersQueue.queueArn],
            }),
        );
        ordersQueue.addToResourcePolicy(
            new iam.PolicyStatement({
                sid: 'AllowExpressLaneConsume',
                effect: iam.Effect.ALLOW,
                principals: [express.role!],
                actions: [
                    'sqs:ReceiveMessage',
                    'sqs:DeleteMessage',
                    'sqs:ChangeMessageVisibility',
                    'sqs:GetQueueAttributes',
                ],
                resources: [ordersQueue.queueArn],
            }),
        );

        const ingestRuleName = `${P}-ingest-schedule`;
        new events.Rule(this, 'IngestSchedule', {
            ruleName: ingestRuleName,
            description: 'Storefront checkout traffic published to the ingest tier once per minute',
            schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
            enabled: true,
            targets: [new targets.LambdaFunction(gateway, { retryAttempts: 2 })],
        });

        // ------------------------------------------------------ observability
        const topicName = `${P}-ops-alerts`;
        const alertTopic = new sns.Topic(this, 'OpsAlerts', {
            topicName,
            displayName: 'Order pipeline operations alerts',
            enforceSSL: true,
        });
        const alarmAction = new cwActions.SnsAction(alertTopic);

        const mkAlarm = (
            logicalId: string,
            alarmName: string,
            metric: cloudwatch.IMetric,
            threshold: number,
            evaluationPeriods: number,
            description: string,
            treatMissingData: cloudwatch.TreatMissingData = cloudwatch.TreatMissingData.NOT_BREACHING,
        ): cloudwatch.Alarm => {
            const alarm = new cloudwatch.Alarm(this, logicalId, {
                alarmName,
                metric,
                threshold,
                evaluationPeriods,
                comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
                alarmDescription: description,
                treatMissingData,
            });
            alarm.addAlarmAction(alarmAction);
            return alarm;
        };

        const backlogAgeAlarmName = `${P}-orders-backlog-age`;
        mkAlarm(
            'OrdersBacklogAgeAlarm',
            backlogAgeAlarmName,
            ordersQueue.metricApproximateAgeOfOldestMessage({
                period: cdk.Duration.minutes(1),
                statistic: 'Maximum',
            }),
            300,
            2,
            'Oldest order event has been waiting more than 5 minutes',
        );

        const backlogDepthAlarmName = `${P}-orders-backlog-depth`;
        mkAlarm(
            'OrdersBacklogDepthAlarm',
            backlogDepthAlarmName,
            ordersQueue.metricApproximateNumberOfMessagesVisible({
                period: cdk.Duration.minutes(1),
                statistic: 'Maximum',
            }),
            100,
            2,
            'Order ingest queue backlog above 100 messages',
        );

        const processorErrorsAlarmName = `${P}-order-processor-errors`;
        mkAlarm(
            'ProcessorErrorsAlarm',
            processorErrorsAlarmName,
            processor.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
            0,
            3,
            'Order processor is returning invocation errors',
        );

        const processorThrottlesAlarmName = `${P}-order-processor-throttles`;
        mkAlarm(
            'ProcessorThrottlesAlarm',
            processorThrottlesAlarmName,
            processor.metricThrottles({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
            0,
            3,
            'Order processor invocations are being throttled',
        );

        const processorDurationAlarmName = `${P}-order-processor-duration`;
        mkAlarm(
            'ProcessorDurationAlarm',
            processorDurationAlarmName,
            processor.metricDuration({ period: cdk.Duration.minutes(5), statistic: 'p99' }),
            100000,
            2,
            'Order processor p99 duration approaching the 120s function timeout',
        );

        const processorLegacyDurationAlarmName = `${P}-order-processor-duration-slo-legacy`;
        mkAlarm(
            'ProcessorLegacyDurationAlarm',
            processorLegacyDurationAlarmName,
            processor.metricDuration({ period: cdk.Duration.minutes(5), statistic: 'Average' }),
            4000,
            2,
            'LEGACY 2019 SLO: average order processing above 4s (threshold predates the multi line item fan out)',
        );

        // Warm pool saturation. Permanently breaching because the alias only has
        // two provisioned environments while the poller runs three invocations,
        // so one of them always spills over onto on-demand concurrency.
        const processorSpilloverAlarmName = `${P}-order-processor-provisioned-concurrency-spillover`;
        mkAlarm(
            'ProcessorSpilloverAlarm',
            processorSpilloverAlarmName,
            processorLive.metric('ProvisionedConcurrencySpilloverInvocations', {
                period: cdk.Duration.minutes(5),
                statistic: 'Sum',
            }),
            0,
            2,
            'Order processor invocations are spilling past the provisioned warm pool of the live alias',
        );

        const processorWarmPoolAlarmName = `${P}-order-processor-warm-pool-utilisation`;
        mkAlarm(
            'ProcessorWarmPoolAlarm',
            processorWarmPoolAlarmName,
            processorLive.metric('ProvisionedConcurrencyUtilization', {
                period: cdk.Duration.minutes(1),
                statistic: 'Maximum',
            }),
            0.9,
            2,
            'Order processor live alias is using more than 90% of its provisioned warm pool',
        );

        // Reserved concurrency utilisation for the processor, expressed against
        // the reservation of 4.
        const processorConcurrency = processor.metric('ConcurrentExecutions', {
            period: cdk.Duration.minutes(1),
            statistic: 'Maximum',
        });
        const processorConcurrencyUtilisation = new cloudwatch.MathExpression({
            expression: '100 * (m1 / 4)',
            usingMetrics: { m1: processorConcurrency },
            label: 'Order processor reserved concurrency utilisation (%)',
            period: cdk.Duration.minutes(1),
        });
        const processorConcurrencyAlarmName = `${P}-order-processor-concurrency-utilisation`;
        mkAlarm(
            'ProcessorConcurrencyUtilisationAlarm',
            processorConcurrencyAlarmName,
            processorConcurrencyUtilisation,
            90,
            3,
            'Order processor is using more than 90% of its reserved concurrency of 4',
        );

        const validatorDurationAlarmName = `${P}-inventory-validator-duration`;
        mkAlarm(
            'ValidatorDurationAlarm',
            validatorDurationAlarmName,
            validator.metricDuration({ period: cdk.Duration.minutes(5), statistic: 'p99' }),
            10000,
            2,
            'Inventory validator p99 duration approaching its 15s timeout',
        );

        const ordersDlqAlarmName = `${P}-orders-dlq-depth`;
        mkAlarm(
            'OrdersDlqAlarm',
            ordersDlqAlarmName,
            ordersDlq.metricApproximateNumberOfMessagesVisible({
                period: cdk.Duration.minutes(1),
                statistic: 'Maximum',
            }),
            0,
            1,
            'Order events have been moved to the dead letter queue',
        );

        const replayBacklogAlarmName = `${P}-orders-replay-backlog`;
        mkAlarm(
            'ReplayBacklogAlarm',
            replayBacklogAlarmName,
            replayQueue.metricApproximateNumberOfMessagesVisible({
                period: cdk.Duration.minutes(1),
                statistic: 'Maximum',
            }),
            0,
            1,
            'Redrive lane has messages waiting - a replay is in progress',
        );

        const notificationsBacklogAlarmName = `${P}-notifications-backlog-age`;
        mkAlarm(
            'NotificationsBacklogAlarm',
            notificationsBacklogAlarmName,
            notificationsQueue.metricApproximateAgeOfOldestMessage({
                period: cdk.Duration.minutes(5),
                statistic: 'Maximum',
            }),
            300,
            1,
            'Oldest notification event has been waiting more than 5 minutes',
        );

        const paymentsBacklogAlarmName = `${P}-payments-backlog-age`;
        mkAlarm(
            'PaymentsBacklogAlarm',
            paymentsBacklogAlarmName,
            paymentsQueue.metricApproximateAgeOfOldestMessage({
                period: cdk.Duration.minutes(5),
                statistic: 'Maximum',
            }),
            300,
            1,
            'Oldest settlement event has been waiting more than 5 minutes',
        );

        const dashboardName = `${P}-order-pipeline`;
        const dashboard = new cloudwatch.Dashboard(this, 'PipelineDashboard', {
            dashboardName,
        });
        dashboard.addWidgets(
            new cloudwatch.GraphWidget({
                title: 'Order ingest queue depth',
                left: [
                    ordersQueue.metricApproximateNumberOfMessagesVisible({
                        period: cdk.Duration.minutes(1),
                        statistic: 'Maximum',
                    }),
                    ordersQueue.metricApproximateNumberOfMessagesNotVisible({
                        period: cdk.Duration.minutes(1),
                        statistic: 'Maximum',
                    }),
                ],
                width: 12,
            }),
            new cloudwatch.GraphWidget({
                title: 'Order processor health',
                left: [
                    processor.metricInvocations({ period: cdk.Duration.minutes(1), statistic: 'Sum' }),
                    processor.metricErrors({ period: cdk.Duration.minutes(1), statistic: 'Sum' }),
                    processor.metricThrottles({ period: cdk.Duration.minutes(1), statistic: 'Sum' }),
                ],
                right: [
                    processor.metricDuration({ period: cdk.Duration.minutes(1), statistic: 'Average' }),
                ],
                width: 12,
            }),
            new cloudwatch.GraphWidget({
                title: 'Order processor concurrency and warm pool',
                left: [processorConcurrency],
                right: [
                    processorLive.metric('ProvisionedConcurrencyUtilization', {
                        period: cdk.Duration.minutes(1),
                        statistic: 'Maximum',
                    }),
                ],
                width: 12,
            }),
        );

        // ------------------------------------------------------------ outputs
        StackUtils.exportStack(this, 'OrdersQueueName', ordersQueueName, 'Order ingest queue name');
        StackUtils.exportStack(
            this,
            'OrdersQueueUrl',
            `https://sqs.${this.region}.amazonaws.com/${this.account}/${ordersQueueName}`,
            'Order ingest queue URL',
        );
        StackUtils.exportStack(
            this,
            'OrdersQueueArn',
            `arn:aws:sqs:${this.region}:${this.account}:${ordersQueueName}`,
            'Order ingest queue ARN',
        );
        StackUtils.exportStack(this, 'OrdersDlqName', ordersDlqName, 'Order ingest dead letter queue name');
        StackUtils.exportStack(this, 'ReplayQueueName', replayQueueName, 'Order redrive lane queue name');
        StackUtils.exportStack(
            this,
            'ReplayQueueUrl',
            `https://sqs.${this.region}.amazonaws.com/${this.account}/${replayQueueName}`,
            'Order redrive lane queue URL',
        );
        StackUtils.exportStack(
            this,
            'NotificationsQueueName',
            notificationsQueueName,
            'Notification queue name',
        );
        StackUtils.exportStack(
            this,
            'PaymentsQueueName',
            paymentsQueueName,
            'Payment settlement queue name',
        );
        StackUtils.exportStack(
            this,
            'PaymentsQueueArn',
            `arn:aws:sqs:${this.region}:${this.account}:${paymentsQueueName}`,
            'Payment settlement queue ARN',
        );
        StackUtils.exportStack(this, 'ProcessorFunctionName', processorName, 'Order processor function name');
        StackUtils.exportStack(
            this,
            'ProcessorAliasName',
            processorAliasName,
            'Alias of the order processor the ingest queue is bound to',
        );
        StackUtils.exportStack(
            this,
            'ExpressFunctionName',
            expressName,
            'Express lane order processor function name (mapping staged, not enabled)',
        );
        StackUtils.exportStack(
            this,
            'AnalyticsTapFunctionName',
            analyticsTapName,
            'Analytics tap function name (side consumer, sampling only)',
        );
        StackUtils.exportStack(
            this,
            'AnalyticsTapAliasName',
            analyticsTapAliasName,
            'Analytics tap live alias name',
        );
        StackUtils.exportStack(
            this,
            'ValidatorFunctionName',
            validatorName,
            'Inventory validator function name',
        );
        StackUtils.exportStack(this, 'GatewayFunctionName', gatewayName, 'Ingest gateway function name');
        StackUtils.exportStack(this, 'FanoutFunctionName', fanoutName, 'Notification fan-out function name');
        StackUtils.exportStack(this, 'SettlerFunctionName', settlerName, 'Payment settler function name');
        StackUtils.exportStack(this, 'OrdersTableName', ordersTableName, 'Processed orders table name');
        StackUtils.exportStack(this, 'InventoryTableName', inventoryTableName, 'Inventory catalog table name');
        StackUtils.exportStack(
            this,
            'NotificationsTableName',
            notificationsTableName,
            'Notification audit table name',
        );
        StackUtils.exportStack(
            this,
            'SupplierLatencyParameterName',
            supplierLatencyParamName,
            'SSM parameter holding the supplier availability latency budget',
        );
        StackUtils.exportStack(this, 'IngestRuleName', ingestRuleName, 'EventBridge ingest schedule rule name');
        StackUtils.exportStack(
            this,
            'BacklogAgeAlarmName',
            backlogAgeAlarmName,
            'Order backlog age alarm name',
        );
        StackUtils.exportStack(
            this,
            'BacklogDepthAlarmName',
            backlogDepthAlarmName,
            'Order backlog depth alarm name',
        );
        StackUtils.exportStack(
            this,
            'ProcessorErrorsAlarmName',
            processorErrorsAlarmName,
            'Order processor errors alarm name',
        );
        StackUtils.exportStack(
            this,
            'ProcessorThrottlesAlarmName',
            processorThrottlesAlarmName,
            'Order processor throttles alarm name',
        );
        StackUtils.exportStack(
            this,
            'ProcessorLegacyDurationAlarmName',
            processorLegacyDurationAlarmName,
            'Legacy order processor duration SLO alarm name',
        );
        StackUtils.exportStack(
            this,
            'ProcessorSpilloverAlarmName',
            processorSpilloverAlarmName,
            'Order processor provisioned concurrency spillover alarm name',
        );
        StackUtils.exportStack(
            this,
            'ProcessorWarmPoolAlarmName',
            processorWarmPoolAlarmName,
            'Order processor provisioned concurrency utilisation alarm name',
        );
        StackUtils.exportStack(
            this,
            'ProcessorConcurrencyAlarmName',
            processorConcurrencyAlarmName,
            'Order processor reserved concurrency utilisation alarm name',
        );
        StackUtils.exportStack(this, 'DashboardName', dashboardName, 'Order pipeline dashboard name');
        StackUtils.exportStack(this, 'AlertTopicName', topicName, 'Operations alert topic name');
    }
}
