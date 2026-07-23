import * as cdk from 'aws-cdk-lib';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { RemovalPolicy } from 'aws-cdk-lib';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: athena_9jhgt3tfs
 * What the stack does:
 * 1. Creates a S3 bucket
 * 2. Creates a database
 * 3. Creates a table
 * */

export class athena_9jhgt3tfs extends cdk.Stack {

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);


        // S3 Bucket for Athena data
        const bucket = new s3.Bucket(this, 'AthenaDataBucket', {
            versioned: true,
            autoDeleteObjects: true,
            encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            removalPolicy: RemovalPolicy.DESTROY,
        });

        // Glue Database
        const database = new glue.CfnDatabase(this, 'GlueDatabase', {
            databaseInput: {
                name: `database-2h4j3i45-${this.account}-${this.region}`,
            },
            catalogId: this.account,
        });

        // Athena Table via Glue
        const athenaTable = new glue.CfnTable(this, 'AthenaTable', {
            databaseName: database.ref,
            tableInput: {
                name: `table-q3h1j4-${this.account}-${this.region}`,
                storageDescriptor: {
                    columns: [
                        { name: 'id', type: 'bigint' },
                        { name: 'name', type: 'string' },
                        { name: 'timestamp', type: 'timestamp' },
                    ],
                    location: `s3://${bucket.bucketName}/data/`,
                    inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
                    outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
                    serdeInfo: {
                        serializationLibrary: 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe',
                    },
                },
            },
            catalogId: this.account,
        });
        athenaTable.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // Outputs
        StackUtils.exportStack(this, 'StackName', this.stackName, 'Stack Name');
        StackUtils.exportStack(this, 'TableName', athenaTable.ref, 'Table Name');
        StackUtils.exportStack(this, 'DatabaseName', database.ref, 'Database Name');
        StackUtils.exportStack(this, 'BucketName', bucket.bucketName, 'S3 Data Bucket Name');
    }
}
