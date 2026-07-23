import * as cdk from 'aws-cdk-lib';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: glue-4hc72iv0v
 *
 * 9a55d25e-f20d-4dfd-ab94-d29c7d60ce55
 *
 * What the stack does:
 * 1. Creates an S3 bucket and uploads a Glue ETL script to it
 * 2. Creates Glue database and table whose data location points to a cross-account S3 bucket
 * 3. Creates IAM role for Glue with AWSLakeFormationDataAdmin
 * 4. Creates Glue job that reads from the table
 *
 * Note: This is a troubleshooting scenario - the Glue job fails with
 * "Insufficient Lake Formation permission(s) on usage_events" because:
 * 1. The Glue role has AWSLakeFormationDataAdmin, which includes lakeformation:* (incl. GetDataAccess),
 *    causing Glue to use Lake Formation credential vending instead of direct IAM S3 access.
 * 2. The account's CreateTableDefaultPermissions is empty (IAMAllowedPrincipals auto-grant disabled),
 *    so no LF permissions exist on the table for the Glue role.
 * Fix: either grant the Glue role SELECT + DESCRIBE on the table in Lake Formation,
 * or remove AWSLakeFormationDataAdmin from the role to fall back to IAM-based S3 access.
 */

export class Glue_4hc72iv0v extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // Owned bucket for the Glue script only
        const scriptBucket = new s3.Bucket(this, 'ScriptBucket', {
            bucketName: `quartz-basalt-scripts-${this.account}-${this.region}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        // Harden the autoDeleteObjects handler with identity-based S3 grants.
        // By default the handler role's ONLY S3 access is the grant each bucket
        // policy gives its exact role ARN. If that grant is stale or gone at
        // delete time, the handler fails its first call (s3:GetBucketTagging)
        // with AccessDenied, the stack delete force-abandons these FIXED-NAME
        // buckets, and every later deploy fails changeset validation with
        // "already exists" — an unrecoverable reset->redeploy loop. Granting
        // the role directly removes the dependence on bucket-policy survival.
        const autoDeleteProvider = this.node.tryFindChild(
            'Custom::S3AutoDeleteObjectsCustomResourceProvider',
        ) as cdk.CustomResourceProviderBase | undefined;
        autoDeleteProvider?.addToRolePolicy({
            Effect: 'Allow',
            Action: ['s3:GetBucket*', 's3:List*', 's3:DeleteObject*', 's3:PutBucketPolicy'],
            Resource: [
                scriptBucket.bucketArn,
                `${scriptBucket.bucketArn}/*`,
            ],
        });

        const scriptDeployment = new s3deploy.BucketDeployment(this, 'GlueScriptDeployment', {
            sources: [s3deploy.Source.data('scripts/etl.py',
                'from awsglue.utils import getResolvedOptions\n' +
                'from awsglue.context import GlueContext\n' +
                'from pyspark.context import SparkContext\n' +
                'import sys\n' +
                'args = getResolvedOptions(sys.argv, ["database", "table"])\n' +
                'sc = SparkContext()\n' +
                'glueContext = GlueContext(sc)\n' +
                'dyf = glueContext.create_dynamic_frame.from_catalog(database=args["database"], table_name=args["table"])\n' +
                'print(dyf.count())\n'
            )],
            destinationBucket: scriptBucket,
        });

        const glueDatabase = new glue.CfnDatabase(this, 'GlueDatabase', {
            catalogId: this.account,
            databaseInput: {
                name: `quartz_basalt_${this.account}_${this.region}`,
                description: 'Database for usage events data',
            },
        });

        // Table points to a cross-account S3 bucket not owned or registered by this account
        const glueTable = new glue.CfnTable(this, 'GlueTable', {
            catalogId: this.account,
            databaseName: glueDatabase.ref,
            tableInput: {
                name: 'usage_events',
                description: 'Usage events data',
                tableType: 'EXTERNAL_TABLE',
                parameters: {
                    classification: 'parquet',
                    compressionType: 'snappy',
                    typeOfData: 'file',
                },
                partitionKeys: [
                    { name: 'serviceid', type: 'string' },
                    { name: 'eventdate', type: 'date' },
                ],
                storageDescriptor: {
                    columns: [
                        { name: 'accountarn', type: 'string' },
                        { name: 'accountid', type: 'string' },
                        { name: 'accountname', type: 'string' },
                        { name: 'eventname', type: 'string' },
                        { name: 'eventtype', type: 'string' },
                        { name: 'timestamp', type: 'bigint' },
                        { name: 'consoleregion', type: 'string' },
                    ],
                    location: 's3://quartz-basalt-partitioned-data-cross-account-us-east-1-prod/usage_events/',
                    inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
                    outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
                    serdeInfo: {
                        serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
                        parameters: { 'serialization.format': '1' },
                    },
                    compressed: true,
                },
            },
        });

        const glueServiceRole = new iam.Role(this, 'GlueServiceRole', {
            roleName: `AWSGlueServiceRoleDefault-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AWSLakeFormationDataAdmin'),
            ],
        });

        const glueJob = new glue.CfnJob(this, 'GlueJob', {
            name: `BASALT_ETL_USAGE_EVENTS_LOAD_${this.account}_${this.region}`,
            role: glueServiceRole.roleArn,
            command: {
                name: 'glueetl',
                pythonVersion: '3',
                scriptLocation: `s3://${scriptBucket.bucketName}/scripts/etl.py`,
            },
            glueVersion: '4.0',
            workerType: 'G.1X',
            numberOfWorkers: 2,
            timeout: 10,
            maxRetries: 0,
            defaultArguments: {
                '--database': glueDatabase.ref,
                '--table': glueTable.ref,
            },
        });

        glueTable.addDependency(glueDatabase);
        glueJob.node.addDependency(scriptDeployment);
        glueJob.addDependency(glueTable);

        StackUtils.exportStack(this, 'GlueDatabaseName', glueDatabase.ref, 'Glue database name');
        StackUtils.exportStack(this, 'GlueTableName', glueTable.ref, 'Glue table name');
        StackUtils.exportStack(this, 'GlueJobName', glueJob.ref, 'Glue job name');
        StackUtils.exportStack(this, 'GlueServiceRoleArn', glueServiceRole.roleArn, 'Glue service role ARN');
    }
}
