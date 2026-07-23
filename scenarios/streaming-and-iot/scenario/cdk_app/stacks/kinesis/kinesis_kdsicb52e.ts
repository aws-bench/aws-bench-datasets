import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: kinesis_kdsicb52e
 *
 * Precondition for the kds-firehose-iceberg-athena task.
 *
 * Frugal split: pre-deploy the source Kinesis Data Stream, the S3 sink
 * bucket, and the IAM role Firehose will assume. The agent creates the
 * Firehose delivery stream with Iceberg configuration and registers the
 * resulting Iceberg table with Glue/Athena.
 */
export class kinesis_kdsicb52e extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const stream = new kinesis.Stream(this, 'KdsStream', {
            streamName: `bench-stream-${this.account.slice(-6)}`,
            shardCount: 1,
            retentionPeriod: cdk.Duration.hours(24),
            streamMode: kinesis.StreamMode.PROVISIONED,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const sink = new s3.Bucket(this, 'IcebergSink', {
            bucketName: `iceberg-sink-${this.account}-${this.region}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
        });

        // Harden the autoDeleteObjects handler with identity-based S3 grants.
        // By default the handler role's ONLY S3 access is the grant the
        // bucket policy gives its exact role ARN. If that grant is stale or
        // gone at delete time, the handler fails its first call
        // (s3:GetBucketTagging) with AccessDenied, the stack delete
        // force-abandons this FIXED-NAME bucket, and every later deploy fails
        // changeset validation with "already exists" — an unrecoverable
        // reset->redeploy loop. Granting the role directly removes the
        // dependence on bucket-policy survival.
        const autoDeleteProvider = this.node.tryFindChild(
            'Custom::S3AutoDeleteObjectsCustomResourceProvider',
        ) as cdk.CustomResourceProviderBase | undefined;
        autoDeleteProvider?.addToRolePolicy({
            Effect: 'Allow',
            Action: ['s3:GetBucket*', 's3:List*', 's3:DeleteObject*', 's3:PutBucketPolicy'],
            Resource: [
                sink.bucketArn,
                `${sink.bucketArn}/*`,
            ],
        });

        // Trust policy permits Firehose to assume; the agent reuses this role
        // when it creates the delivery stream rather than rolling a new one.
        const firehoseRole = new iam.Role(this, 'FirehoseRole', {
            roleName: `firehose-iceberg-role-${this.account.slice(-6)}`,
            assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
        });
        stream.grantRead(firehoseRole);
        sink.grantReadWrite(firehoseRole);
        // Glue access for Iceberg catalog operations.
        firehoseRole.addToPolicy(
            new iam.PolicyStatement({
                actions: [
                    'glue:GetTable',
                    'glue:GetTableVersion',
                    'glue:GetTableVersions',
                    'glue:GetDatabase',
                    'glue:UpdateTable',
                ],
                resources: ['*'],
            }),
        );

        StackUtils.exportStack(this, 'KinesisStreamName', stream.streamName, 'KDS source stream');
        StackUtils.exportStack(this, 'S3BucketName', sink.bucketName, 'Iceberg destination bucket');
        StackUtils.exportStack(this, 'FirehoseRoleName', firehoseRole.roleName, 'Role Firehose assumes');
    }
}
