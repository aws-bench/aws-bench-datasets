import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * DynamoDB Streams to Lambda to SNS Stack
 *
 * Converted from aws-cdk-examples/typescript/ddb-stream-lambda-sns
 *
 * Creates:
 * 1. SNS topic (encrypted with AWS-managed KMS, enforces SSL)
 * 2. L2 portion: DynamoDB table (itemL2Table) with streams -> Lambda -> publishes to SNS
 *    - SQS dead-letter queue for failed stream processing
 *    - DynamoDB stream -> Lambda event source mapping with DLQ
 * 3. L3 portion (replicated with standard CDK): Second DynamoDB table (itemL3Table)
 *    with streams -> second Lambda -> publishes to same SNS topic
 *    - Separate SQS DLQ for the L3 event source mapping
 *    - Point-in-time recovery enabled on L3 table
 */

export class DynamodbStreamSns extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // Shared SNS KMS key
        const snsKmsKey = kms.Alias.fromAliasName(this, 'AwsManagedSnsKmsKey', 'alias/aws/sns');

        // Shared SNS topic
        const snsTopic = new sns.Topic(this, 'DdbStreamTopic', {
            topicName: `ddb-stream-topic-${this.account}-${this.region}`,
            displayName: 'SNS Topic for DDB Stream Inventory Alerts',
            enforceSSL: true,
            masterKey: snsKmsKey,
        });
        snsTopic.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Dedicated CMK for the stream tables' at-rest encryption. Provisioned in
        // this stack (not the account's lazily-created aws/dynamodb managed key),
        // so the tables that reference it deploy after it exists — removing the
        // key-propagation race that fails CreateTable in a freshly-vended account.
        const tableEncryptionKey = new kms.Key(this, 'DdbStreamTableKey', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            enableKeyRotation: true,
        });

        // =====================================================================
        // L2 CDK Construct portion
        // =====================================================================

        const deadLetterQueueL2 = new sqs.Queue(this, 'DdbStreamL2Dlq', {
            queueName: `ddb-stream-l2-dlq-${this.account}-${this.region}`,
            encryption: sqs.QueueEncryption.KMS_MANAGED,
            retentionPeriod: cdk.Duration.days(4),
            enforceSSL: true,
        });
        deadLetterQueueL2.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        const itemL2Table = new dynamodb.Table(this, 'ItemL2Table', {
            tableName: `ddb-stream-l2-items-${this.account}-${this.region}`,
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
            encryptionKey: tableEncryptionKey,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const itemL2TableLambdaFunction = new lambda.Function(this, 'ItemL2TableLambdaFunction', {
            functionName: `ddb-stream-l2-processor-${this.account}-${this.region}`,
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            tracing: lambda.Tracing.ACTIVE,
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/dynamodb-stream-handler')),
            environment: {
                SNS_TOPIC_ARN: snsTopic.topicArn,
                AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
            },
        });

        itemL2TableLambdaFunction.addEventSource(new lambdaEventSources.DynamoEventSource(itemL2Table, {
            startingPosition: lambda.StartingPosition.TRIM_HORIZON,
            onFailure: new lambdaEventSources.SqsDlq(deadLetterQueueL2),
            bisectBatchOnError: true,
            maxRecordAge: cdk.Duration.hours(24),
            retryAttempts: 500,
        }));

        deadLetterQueueL2.grantSendMessages(itemL2TableLambdaFunction);
        itemL2Table.grantStreamRead(itemL2TableLambdaFunction);

        // =====================================================================
        // L3 CDK Construct portion (replicated with standard L2 constructs)
        // Originally used @aws-solutions-constructs/aws-dynamodbstreams-lambda
        // =====================================================================

        // L3 DLQ - auto-created by the solutions construct with KMS_MANAGED encryption
        const deadLetterQueueL3 = new sqs.Queue(this, 'ItemL3TableSqsDlqQueue', {
            queueName: `ddb-stream-l3-dlq-${this.account}-${this.region}`,
            encryption: sqs.QueueEncryption.KMS_MANAGED,
            enforceSSL: true,
        });
        deadLetterQueueL3.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // L3 DynamoDB table - the solutions construct enables pointInTimeRecovery
        const itemL3Table = new dynamodb.Table(this, 'ItemL3TableDynamoTable', {
            tableName: `ddb-stream-l3-items-${this.account}-${this.region}`,
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
            encryptionKey: tableEncryptionKey,
            pointInTimeRecovery: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // L3 Lambda function - the solutions construct enables tracing
        const itemL3TableLambdaFunction = new lambda.Function(this, 'ItemL3TableLambdaFunction', {
            functionName: `ddb-stream-l3-processor-${this.account}-${this.region}`,
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            tracing: lambda.Tracing.ACTIVE,
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/dynamodb-stream-handler')),
            environment: {
                SNS_TOPIC_ARN: snsTopic.topicArn,
            },
        });

        itemL3TableLambdaFunction.addEventSource(new lambdaEventSources.DynamoEventSource(itemL3Table, {
            startingPosition: lambda.StartingPosition.TRIM_HORIZON,
            onFailure: new lambdaEventSources.SqsDlq(deadLetterQueueL3),
            bisectBatchOnError: true,
            maxRecordAge: cdk.Duration.hours(24),
            retryAttempts: 500,
        }));

        itemL3Table.grantStreamRead(itemL3TableLambdaFunction);

        // Grant SNS publish to both Lambda functions
        snsTopic.grantPublish(itemL2TableLambdaFunction);
        snsTopic.grantPublish(itemL3TableLambdaFunction);

        // Exports matching original CfnOutputs
        StackUtils.exportStack(this, 'itemL2TableLambdaFunctionArn', itemL2TableLambdaFunction.functionArn, 'L2 stream processor Lambda function ARN');
        StackUtils.exportStack(this, 'itemL3TableLambdaFunctionArn', itemL3TableLambdaFunction.functionArn, 'L3 stream processor Lambda function ARN');
        StackUtils.exportStack(this, 'l3TableArn', itemL3Table.tableArn, 'L3 DynamoDB table ARN');
        StackUtils.exportStack(this, 'l2TableArn', itemL2Table.tableArn, 'L2 DynamoDB table ARN');
        StackUtils.exportStack(this, 'topicArn', snsTopic.topicArn, 'SNS topic ARN');
        StackUtils.exportStack(this, 'l2DLQArn', deadLetterQueueL2.queueArn, 'L2 dead-letter queue ARN');
        StackUtils.exportStack(this, 'l3DLQArn', deadLetterQueueL3.queueArn, 'L3 dead-letter queue ARN');
    }
}
