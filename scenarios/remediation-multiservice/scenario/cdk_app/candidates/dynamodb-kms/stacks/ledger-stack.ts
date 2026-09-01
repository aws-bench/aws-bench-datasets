import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as path from 'path';
import { StackUtils } from '../lib/shared';

export interface LedgerStackProps extends cdk.StackProps {
    /** 9-char base36 stack suffix. */
    readonly suffix: string;
}

// Opaque tag literals; they appear in no resource name, only in Condition blocks.
const BOUNDARY_TAG_KEY = 'x-27f3b8';
const BOUNDARY_TAG_VALUE = 'Q4';
const KEY_SCOPE_TAG_KEY = 'x-58b1d9';
const KEY_SCOPE_TAG_VALUE = 'H';
const CMK_RESOURCE_TAG_KEY = 'data-domain';
const CMK_RESOURCE_TAG_VALUE = 'ledger';

/**
 * Payments ledger platform.
 *
 * The write path is gated by three independent auth layers:
 *   A) Writer identity policy allows KMS envelope-encryption under a scoping
 *      encryption-context condition.
 *   B) Data-protection boundary DENIES ledger CMK crypto for principals lacking
 *      an opaque data-scope PrincipalTag.
 *   C) Ledger CMK key policy grants crypto only to principals holding a second
 *      opaque PrincipalTag (no enumerated approved principals).
 * Sibling readers and loaders share the CMK.
 */
export class LedgerStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: LedgerStackProps) {
        super(scope, id, props);

        const sfx = props.suffix;

        // ---------------------------------------------------------------- names
        const ledgerTableName = `ledger-transactions-${sfx}`;
        const auditTableName = `ledger-audit-events-${sfx}`;
        const analyticsTableName = `analytics-aggregates-${sfx}`;

        const writerRoleName = `ledger-writer-role-${sfx}`;
        const readerRoleName = `ledger-reader-role-${sfx}`;
        const backfillRoleName = `ledger-backfill-role-${sfx}`;
        const reconcilerRoleName = `ledger-reconciler-role-${sfx}`;

        const writerFnName = `ledger-writer-${sfx}`;
        const readerFnName = `ledger-reader-${sfx}`;
        const backfillFnName = `ledger-backfill-${sfx}`;
        const reconcilerFnName = `ledger-reconciler-${sfx}`;

        const failedQueueName = `ledger-writer-failed-records-${sfx}`;
        const topicName = `ledger-ops-alerts-${sfx}`;
        const alarmName = `ledger-writer-persist-errors-${sfx}`;
        const boundaryPolicyName = `ledger-data-protection-boundary-${sfx}`;
        const regionBoundaryPolicyName = `ledger-region-boundary-${sfx}`;
        const ledgerKeyAliasName = `alias/ledger-pci-${sfx}`;
        const analyticsKeyAliasName = `alias/ledger-analytics-${sfx}`;
        const reportBucketName = `ledger-reports-${this.account}-${sfx}`;

        // ------------------------------------------------------------- IAM roles
        const lambdaBasic = iam.ManagedPolicy.fromAwsManagedPolicyName(
            'service-role/AWSLambdaBasicExecutionRole',
        );

        // Sibling role ARNs need to be known up-front so we can seed a
        // permanent (tag-independent) key-policy Allow for them.  The Allow
        // deliberately does NOT list the writer -- writer's only key-policy
        // path is via the opaque PrincipalTag Allow.
        const backfillRoleArn = cdk.Stack.of(this).formatArn({
            service: 'iam',
            region: '',
            resource: 'role',
            resourceName: backfillRoleName,
        });
        const readerRoleArn = cdk.Stack.of(this).formatArn({
            service: 'iam',
            region: '',
            resource: 'role',
            resourceName: readerRoleName,
        });

        const applyLedgerNoiseTags = (role: iam.Role, service: string, owner: string) => {
            cdk.Tags.of(role).add('Service', service);
            cdk.Tags.of(role).add('Owner', owner);
            cdk.Tags.of(role).add('data-owner', 'payments-platform');
            cdk.Tags.of(role).add('region-scope', 'ue1');
            cdk.Tags.of(role).add('pci-band', 'A');
            cdk.Tags.of(role).add('audit-tier', 'T2');
            cdk.Tags.of(role).add('env-class', 'prod');
            cdk.Tags.of(role).add('iso-27001', 'covered');
            cdk.Tags.of(role).add('x-27f3b8-fallback', 'Q3');
            cdk.Tags.of(role).add('x-27f3b8-audit', 'T3');
            cdk.Tags.of(role).add('x-58b1d9-shadow', 'X');
        };

        const writerRole = new iam.Role(this, 'WriterRole', {
            roleName: writerRoleName,
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            description: 'Execution role for the online ledger write path',
            managedPolicies: [lambdaBasic],
        });
        applyLedgerNoiseTags(writerRole, 'ledger-writer', 'payments-platform');
        // intentional: broken by design -- writer starts missing BOTH data-scope
        // tags.

        const readerRole = new iam.Role(this, 'ReaderRole', {
            roleName: readerRoleName,
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            description: 'Execution role for the ledger read/detokenise path',
            managedPolicies: [lambdaBasic],
        });
        applyLedgerNoiseTags(readerRole, 'ledger-reader', 'payments-platform');
        cdk.Tags.of(readerRole).add(BOUNDARY_TAG_KEY, BOUNDARY_TAG_VALUE);
        cdk.Tags.of(readerRole).add(KEY_SCOPE_TAG_KEY, KEY_SCOPE_TAG_VALUE);

        const backfillRole = new iam.Role(this, 'BackfillRole', {
            roleName: backfillRoleName,
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            description: 'Execution role for the historical ledger backfill job',
            managedPolicies: [lambdaBasic],
        });
        applyLedgerNoiseTags(backfillRole, 'ledger-backfill', 'payments-platform');
        // Deliberately carries no data-scope tags.

        const reconcilerRole = new iam.Role(this, 'ReconcilerRole', {
            roleName: reconcilerRoleName,
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            description: 'Execution role for the nightly analytics reconciler',
            managedPolicies: [lambdaBasic],
        });
        cdk.Tags.of(reconcilerRole).add('Service', 'ledger-analytics');
        cdk.Tags.of(reconcilerRole).add('Owner', 'data-platform');

        // ------------------------------------------------------------- KMS keys
        // Ledger CMK: cryptographic use gated by an opaque PrincipalTag; no
        // enumerated approved-principal list. The key itself carries a scoping
        // ResourceTag so identity policies can safely reference key/* and still
        // pin down to this specific CMK.
        const ledgerKeyPolicy = new iam.PolicyDocument({
            statements: [
                new iam.PolicyStatement({
                    sid: 'AllowKeyAdministration',
                    effect: iam.Effect.ALLOW,
                    principals: [new iam.AccountRootPrincipal()],
                    actions: [
                        'kms:Describe*',
                        'kms:Get*',
                        'kms:List*',
                        'kms:Put*',
                        'kms:Update*',
                        'kms:Enable*',
                        'kms:Disable*',
                        'kms:Revoke*',
                        'kms:Retire*',
                        'kms:CreateAlias',
                        'kms:DeleteAlias',
                        'kms:CreateGrant',
                        'kms:TagResource',
                        'kms:UntagResource',
                        'kms:ScheduleKeyDeletion',
                        'kms:CancelKeyDeletion',
                    ],
                    resources: ['*'],
                }),
                new iam.PolicyStatement({
                    sid: 'AllowDynamoDbServiceIntegration',
                    effect: iam.Effect.ALLOW,
                    principals: [new iam.AccountRootPrincipal()],
                    actions: [
                        'kms:Encrypt',
                        'kms:Decrypt',
                        'kms:ReEncrypt*',
                        'kms:GenerateDataKey*',
                        'kms:DescribeKey',
                        'kms:CreateGrant',
                    ],
                    resources: ['*'],
                    conditions: {
                        StringEquals: {
                            'kms:ViaService': `dynamodb.${this.region}.amazonaws.com`,
                            'kms:CallerAccount': this.account,
                        },
                    },
                }),
                new iam.PolicyStatement({
                    sid: 'AllowLedgerCryptoByPrincipalTag',
                    effect: iam.Effect.ALLOW,
                    principals: [new iam.AccountRootPrincipal()],
                    actions: ['kms:GenerateDataKey*', 'kms:Decrypt', 'kms:Encrypt', 'kms:DescribeKey'],
                    resources: ['*'],
                    conditions: {
                        StringEquals: {
                            [`aws:PrincipalTag/${KEY_SCOPE_TAG_KEY}`]: KEY_SCOPE_TAG_VALUE,
                        },
                    },
                }),
                // Sibling permanent Allow for backfill + reader roles.
                // Uses Principal: root + ArnLike condition on aws:PrincipalArn so
                // KMS accepts the statement at key-create time (roles do not need
                // to pre-exist; only the account root is validated as principal).
                // The two role ARNs are computed via Stack.formatArn (deterministic
                // from role names). Writer is intentionally NOT included — its only
                // key-policy path stays the PrincipalTag Allow above.
                new iam.PolicyStatement({
                    sid: 'AllowLedgerCryptoForSiblingRoles',
                    effect: iam.Effect.ALLOW,
                    principals: [new iam.AccountRootPrincipal()],
                    actions: [
                        'kms:GenerateDataKey*',
                        'kms:Decrypt',
                        'kms:Encrypt',
                        'kms:ReEncrypt*',
                        'kms:DescribeKey',
                    ],
                    resources: ['*'],
                    conditions: {
                        ArnLike: {
                            'aws:PrincipalArn': [
                                backfillRoleArn,
                                readerRoleArn,
                            ],
                        },
                    },
                }),
            ],
        });

        const ledgerKey = new kms.Key(this, 'LedgerKey', {
            alias: ledgerKeyAliasName,
            description: 'Customer managed key for the PCI ledger (table SSE + field-level PAN encryption)',
            enableKeyRotation: true,
            policy: ledgerKeyPolicy,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            pendingWindow: cdk.Duration.days(7),
        });
        cdk.Tags.of(ledgerKey).add(CMK_RESOURCE_TAG_KEY, CMK_RESOURCE_TAG_VALUE);

        // The key policy's `AllowLedgerCryptoForSiblingRoles` statement uses
        // Principal:root + Condition ArnLike, which delegates crypto authorization
        // to IAM identity policies. Grant matching crypto rights on the backfill
        // and reader roles' identity policies so the delegation actually resolves.
        // Writer intentionally excluded — its only key-policy path stays the
        // opaque PrincipalTag Allow.
        new iam.Policy(this, 'BackfillLedgerCryptoPolicy', {
            roles: [backfillRole],
            statements: [
                new iam.PolicyStatement({
                    actions: [
                        'kms:GenerateDataKey*',
                        'kms:Decrypt',
                        'kms:Encrypt',
                        'kms:ReEncrypt*',
                        'kms:DescribeKey',
                    ],
                    resources: [ledgerKey.keyArn],
                }),
            ],
        });
        new iam.Policy(this, 'ReaderLedgerCryptoPolicy', {
            roles: [readerRole],
            statements: [
                new iam.PolicyStatement({
                    actions: [
                        'kms:Decrypt',
                        'kms:DescribeKey',
                    ],
                    resources: [ledgerKey.keyArn],
                }),
            ],
        });

        const analyticsKey = new kms.Key(this, 'AnalyticsKey', {
            alias: analyticsKeyAliasName,
            description: 'Customer managed key for the analytics aggregates table and report bucket',
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            pendingWindow: cdk.Duration.days(7),
        });

        // ------------------------------------------------------------- DynamoDB
        const ledgerTable = new dynamodb.Table(this, 'LedgerTable', {
            tableName: ledgerTableName,
            partitionKey: { name: 'accountId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'txnId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
            encryptionKey: ledgerKey,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const auditTable = new dynamodb.Table(this, 'AuditTable', {
            tableName: auditTableName,
            partitionKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'emittedAt', type: dynamodb.AttributeType.NUMBER },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption: dynamodb.TableEncryption.AWS_MANAGED,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const analyticsTable = new dynamodb.Table(this, 'AnalyticsTable', {
            tableName: analyticsTableName,
            partitionKey: { name: 'merchantId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'period', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
            encryptionKey: analyticsKey,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // DynamoDB validates a table's SSE key during creation and fails the
        // resource with `KMS validation error: NotFoundException` when KMS has
        // not yet made that key consistently readable. AuditTable is
        // AWS_MANAGED, so its `aws/dynamodb` key does not exist until DynamoDB
        // creates it on first use — unavoidably fresh on the first deploy into a
        // new account. Creating these three tables concurrently lets one observe
        // another's just-created key too early, so serialize them; the two CMK
        // tables also then follow their own keys by an extra step.
        auditTable.node.addDependency(ledgerTable);
        analyticsTable.node.addDependency(auditTable);

        // ------------------------------------------------------- messaging / S3
        const failedRecords = new sqs.Queue(this, 'FailedRecords', {
            queueName: failedQueueName,
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            retentionPeriod: cdk.Duration.days(4),
            visibilityTimeout: cdk.Duration.seconds(60),
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const alertsTopic = new sns.Topic(this, 'AlertsTopic', {
            topicName: topicName,
            displayName: 'Ledger platform operational alerts',
        });

        const reportBucket = new s3.Bucket(this, 'ReportBucket', {
            bucketName: reportBucketName,
            encryption: s3.BucketEncryption.KMS,
            encryptionKey: analyticsKey,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // -------------------------------------------------- identity policies
        // Writer: KMS crypto is granted via a wildcard resource pinned
        // to the ledger CMK by ResourceTag, with an encryption-context scoping
        // condition. **The context key name is spelled wrong** (`tableName` vs.
        // the writer's actual `table`) -- this is Layer A.
        writerRole.attachInlinePolicy(
            new iam.Policy(this, 'WriterInlinePolicy', {
                policyName: 'ledger-write-access',
                statements: [
                    new iam.PolicyStatement({
                        sid: 'LedgerTableWrite',
                        actions: [
                            'dynamodb:PutItem',
                            'dynamodb:UpdateItem',
                            'dynamodb:BatchWriteItem',
                            'dynamodb:DescribeTable',
                        ],
                        resources: [ledgerTable.tableArn],
                    }),
                    new iam.PolicyStatement({
                        sid: 'AuditTrailWrite',
                        actions: ['dynamodb:PutItem'],
                        resources: [auditTable.tableArn],
                    }),
                    new iam.PolicyStatement({
                        sid: 'FailedRecordPublish',
                        actions: ['sqs:SendMessage', 'sqs:GetQueueUrl', 'sqs:GetQueueAttributes'],
                        resources: [failedRecords.queueArn],
                    }),
                    new iam.PolicyStatement({
                        sid: 'LedgerFieldEnvelopeEncrypt',
                        actions: [
                            'kms:GenerateDataKey',
                            'kms:GenerateDataKeyWithoutPlaintext',
                            'kms:Decrypt',
                            'kms:DescribeKey',
                        ],
                        // Wildcard resource, pinned to the ledger CMK by tag.
                        resources: [`arn:aws:kms:${this.region}:${this.account}:key/*`],
                        conditions: {
                            StringEquals: {
                                [`aws:ResourceTag/${CMK_RESOURCE_TAG_KEY}`]: CMK_RESOURCE_TAG_VALUE,
                                // BROKEN BY DESIGN: writer sends
                                //   EncryptionContext={"table": TABLE, "accountId": ...}
                                // but this condition asks for `tableName`. Silent Deny on
                                // GenerateDataKey unless the key name is corrected.
                                'kms:EncryptionContext:tableName': ledgerTableName,
                            },
                        },
                    }),
                ],
            }),
        );

        readerRole.attachInlinePolicy(
            new iam.Policy(this, 'ReaderInlinePolicy', {
                policyName: 'ledger-read-access',
                statements: [
                    new iam.PolicyStatement({
                        sid: 'LedgerTableRead',
                        actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:DescribeTable'],
                        resources: [ledgerTable.tableArn],
                    }),
                    new iam.PolicyStatement({
                        sid: 'LedgerFieldDecrypt',
                        actions: ['kms:Decrypt', 'kms:DescribeKey'],
                        resources: [`arn:aws:kms:${this.region}:${this.account}:key/*`],
                        conditions: {
                            StringEquals: {
                                [`aws:ResourceTag/${CMK_RESOURCE_TAG_KEY}`]: CMK_RESOURCE_TAG_VALUE,
                                'kms:EncryptionContext:table': ledgerTableName,
                            },
                        },
                    }),
                ],
            }),
        );

        backfillRole.attachInlinePolicy(
            new iam.Policy(this, 'BackfillInlinePolicy', {
                policyName: 'ledger-backfill-access',
                statements: [
                    new iam.PolicyStatement({
                        sid: 'LedgerTableLoad',
                        actions: ['dynamodb:PutItem', 'dynamodb:BatchWriteItem', 'dynamodb:DescribeTable'],
                        resources: [ledgerTable.tableArn],
                    }),
                    new iam.PolicyStatement({
                        sid: 'LedgerFieldEncrypt',
                        actions: [
                            'kms:GenerateDataKey',
                            'kms:GenerateDataKeyWithoutPlaintext',
                            'kms:Decrypt',
                            'kms:DescribeKey',
                        ],
                        resources: [`arn:aws:kms:${this.region}:${this.account}:key/*`],
                        conditions: {
                            StringEquals: {
                                [`aws:ResourceTag/${CMK_RESOURCE_TAG_KEY}`]: CMK_RESOURCE_TAG_VALUE,
                                'kms:EncryptionContext:table': ledgerTableName,
                            },
                        },
                    }),
                ],
            }),
        );

        reconcilerRole.attachInlinePolicy(
            new iam.Policy(this, 'ReconcilerInlinePolicy', {
                policyName: 'ledger-analytics-access',
                statements: [
                    new iam.PolicyStatement({
                        sid: 'AnalyticsTableRead',
                        actions: ['dynamodb:Scan', 'dynamodb:DescribeTable'],
                        resources: [analyticsTable.tableArn],
                    }),
                    new iam.PolicyStatement({
                        sid: 'ReportWrite',
                        actions: ['s3:PutObject', 's3:GetObject'],
                        resources: [`${reportBucket.bucketArn}/reports/*`],
                    }),
                    new iam.PolicyStatement({
                        sid: 'AnalyticsEnvelopeEncryption',
                        actions: [
                            'kms:GenerateDataKey',
                            'kms:GenerateDataKeyWithoutPlaintext',
                            'kms:Encrypt',
                            'kms:Decrypt',
                            'kms:DescribeKey',
                        ],
                        resources: [analyticsKey.keyArn],
                    }),
                ],
            }),
        );

        // Data protection boundary attached to every ledger workload role: the PCI
        // CMK may only be used cryptographically by principals whose opaque
        // data-scope tag matches. The tag key/value are not documented in any
        // resource name -- they must be read out of this document's Condition.
        new iam.ManagedPolicy(this, 'DataProtectionBoundary', {
            managedPolicyName: boundaryPolicyName,
            description: 'Ledger data protection boundary: gates PCI CMK crypto on an opaque PrincipalTag',
            roles: [writerRole, readerRole, backfillRole],
            document: new iam.PolicyDocument({
                statements: [
                    new iam.PolicyStatement({
                        sid: 'DenyLedgerKeyUseByUntaggedPrincipals',
                        effect: iam.Effect.DENY,
                        actions: [
                            'kms:GenerateDataKey*',
                            'kms:Encrypt',
                            'kms:Decrypt',
                            'kms:ReEncrypt*',
                        ],
                        resources: [ledgerKey.keyArn],
                        conditions: {
                            StringNotEquals: {
                                [`aws:PrincipalTag/${BOUNDARY_TAG_KEY}`]: BOUNDARY_TAG_VALUE,
                            },
                        },
                    }),
                    new iam.PolicyStatement({
                        sid: 'DenyLedgerKeyDestruction',
                        effect: iam.Effect.DENY,
                        actions: ['kms:ScheduleKeyDeletion', 'kms:DisableKey', 'kms:DisableKeyRotation'],
                        resources: [ledgerKey.keyArn],
                    }),
                    new iam.PolicyStatement({
                        sid: 'AllowLedgerKeyMetadata',
                        effect: iam.Effect.ALLOW,
                        actions: ['kms:DescribeKey'],
                        resources: [ledgerKey.keyArn],
                    }),
                ],
            }),
        });

        // Regional isolation boundary attached to the same ledger workload roles.
        // Denies cryptographic operations against the ledger CMK only when the
        // request originates from the secondary DR region; the primary region
        // (where the workload actually runs) is untouched.
        new iam.ManagedPolicy(this, 'RegionBoundary', {
            managedPolicyName: regionBoundaryPolicyName,
            description: 'Ledger regional data protection boundary: PCI CMK use is denied when initiated from the secondary DR region',
            roles: [writerRole, readerRole, backfillRole],
            document: new iam.PolicyDocument({
                statements: [
                    new iam.PolicyStatement({
                        sid: 'DenyLedgerKeyUseInSecondaryRegion',
                        effect: iam.Effect.DENY,
                        actions: [
                            'kms:GenerateDataKey*',
                            'kms:Encrypt',
                            'kms:Decrypt',
                            'kms:ReEncrypt*',
                        ],
                        resources: [ledgerKey.keyArn],
                        conditions: {
                            StringEquals: {
                                'aws:RequestedRegion': 'us-east-2',
                            },
                        },
                    }),
                ],
            }),
        });

        // ------------------------------------------------------------- functions
        const mkLogGroup = (logicalId: string, fnName: string) =>
            new logs.LogGroup(this, logicalId, {
                logGroupName: `/aws/lambda/${fnName}`,
                retention: logs.RetentionDays.ONE_DAY,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            });

        const writerFn = new lambda.Function(this, 'WriterFunction', {
            functionName: writerFnName,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../assets/ledger_writer')),
            role: writerRole,
            timeout: cdk.Duration.seconds(30),
            memorySize: 256,
            description: 'Online ledger write path (PAN field-level encryption + DynamoDB PutItem)',
            environment: {
                LEDGER_TABLE_NAME: ledgerTableName,
                LEDGER_KMS_KEY_ARN: ledgerKey.keyArn,
                FAILED_RECORDS_QUEUE_URL: failedRecords.queueUrl,
                WRITER_VERSION: '2.4.1',
            },
            logGroup: mkLogGroup('WriterLogGroup', writerFnName),
        });

        new lambda.Function(this, 'ReaderFunction', {
            functionName: readerFnName,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../assets/ledger_reader')),
            role: readerRole,
            timeout: cdk.Duration.seconds(30),
            memorySize: 256,
            description: 'Ledger read path (DynamoDB GetItem + PAN detokenisation)',
            environment: {
                LEDGER_TABLE_NAME: ledgerTableName,
            },
            logGroup: mkLogGroup('ReaderLogGroup', readerFnName),
        });

        new lambda.Function(this, 'BackfillFunction', {
            functionName: backfillFnName,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../assets/ledger_backfill')),
            role: backfillRole,
            timeout: cdk.Duration.minutes(2),
            memorySize: 512,
            description: 'Historical ledger backfill loader',
            environment: {
                LEDGER_TABLE_NAME: ledgerTableName,
                LEDGER_KMS_KEY_ARN: ledgerKey.keyArn,
                BACKFILL_VERSION: '1.9.0',
            },
            logGroup: mkLogGroup('BackfillLogGroup', backfillFnName),
        });

        new lambda.Function(this, 'ReconcilerFunction', {
            functionName: reconcilerFnName,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../assets/ledger_reconciler')),
            role: reconcilerRole,
            timeout: cdk.Duration.minutes(2),
            memorySize: 512,
            description: 'Nightly merchant rollup reconciler',
            environment: {
                ANALYTICS_TABLE_NAME: analyticsTableName,
                REPORT_BUCKET_NAME: reportBucketName,
                ANALYTICS_KMS_KEY_ARN: analyticsKey.keyArn,
            },
            logGroup: mkLogGroup('ReconcilerLogGroup', reconcilerFnName),
        });

        // --------------------------------------------------------------- alarms
        const writeErrorAlarm = new cloudwatch.Alarm(this, 'WriterErrorAlarm', {
            alarmName: alarmName,
            alarmDescription: 'ledger-writer invocations are failing to persist transactions',
            metric: writerFn.metricErrors({ period: cdk.Duration.minutes(1), statistic: 'Sum' }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        writeErrorAlarm.addAlarmAction(new cwActions.SnsAction(alertsTopic));

        const backlogAlarm = new cloudwatch.Alarm(this, 'FailedRecordsBacklogAlarm', {
            alarmName: `ledger-failed-records-backlog-${sfx}`,
            alarmDescription: 'ledger-writer failed-records queue is accumulating messages',
            metric: failedRecords.metricApproximateNumberOfMessagesVisible({
                period: cdk.Duration.minutes(1),
                statistic: 'Maximum',
            }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        backlogAlarm.addAlarmAction(new cwActions.SnsAction(alertsTopic));

        // -------------------------------------------------------------- outputs
        StackUtils.exportStack(this, 'LedgerTableName', ledgerTableName, 'PCI ledger table');
        StackUtils.exportStack(this, 'AuditTableName', auditTableName, 'Ledger audit event table');
        StackUtils.exportStack(this, 'AnalyticsTableName', analyticsTableName, 'Analytics aggregates table');
        StackUtils.exportStack(this, 'LedgerKeyAliasName', ledgerKeyAliasName, 'Ledger CMK alias');
        StackUtils.exportStack(this, 'AnalyticsKeyAliasName', analyticsKeyAliasName, 'Analytics CMK alias');
        StackUtils.exportStack(this, 'WriterFunctionName', writerFnName, 'Online ledger writer function');
        StackUtils.exportStack(this, 'ReaderFunctionName', readerFnName, 'Ledger reader function');
        StackUtils.exportStack(this, 'BackfillFunctionName', backfillFnName, 'Ledger backfill function');
        StackUtils.exportStack(this, 'ReconcilerFunctionName', reconcilerFnName, 'Analytics reconciler function');
        StackUtils.exportStack(this, 'WriterRoleName', writerRoleName, 'Writer execution role');
        StackUtils.exportStack(this, 'ReaderRoleName', readerRoleName, 'Reader execution role');
        StackUtils.exportStack(this, 'BackfillRoleName', backfillRoleName, 'Backfill execution role');
        StackUtils.exportStack(this, 'BoundaryPolicyName', boundaryPolicyName, 'Data protection boundary policy');
        StackUtils.exportStack(this, 'RegionBoundaryPolicyName', regionBoundaryPolicyName, 'Regional data protection boundary policy');
        StackUtils.exportStack(this, 'FailedRecordsQueueName', failedQueueName, 'Writer failed-records queue');
        StackUtils.exportStack(this, 'WriterAlarmName', alarmName, 'Writer persistence error alarm');
        StackUtils.exportStack(this, 'ReportBucketName', reportBucketName, 'Analytics report bucket');
    }
}
