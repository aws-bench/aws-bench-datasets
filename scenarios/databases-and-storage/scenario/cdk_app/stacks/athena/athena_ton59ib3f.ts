import * as cdk from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';
import * as logs from 'aws-cdk-lib/aws-logs';

/*
 * AthenaStack ID: athena_ton59ib3f
 *
 * The stack creates the following resources:
 *
 * 1. S3 bucket for Athena query results
 * 2. Glue database with ANDES 3.0 dataset (QuickSight analytics)
 * 3. Athena workgroup for query execution
 * 4. 1 Lambda function to execute Athena queries
 *
 */

export class athena_ton59ib3f extends cdk.Stack {

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);


        // S3 bucket for Athena query results
        const queryResultsBucket = new s3.Bucket(this, 'AthenaQueryResultsS3', {
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
        });
        queryResultsBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Glue database for ANDES 3.0 dataset
        const andesDatabase = new glue.CfnDatabase(this, 'AndesDatabase', {
            catalogId: this.account,
            databaseInput: {
                name: 'andes_3_0_db',
                description: 'ANDES 3.0 dataset for QuickSight analytics',
            },
        });
        andesDatabase.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Sample Glue table (represents existing tables)
        const glueTable = new glue.CfnTable(this, 'SampleTable', {
            catalogId: this.account,
            databaseName: andesDatabase.ref,
            tableInput: {
                name: 'andes_3_0_data',
                tableType: 'EXTERNAL_TABLE',
                storageDescriptor: {
                    columns: [
                        { name: 'id', type: 'bigint' },
                        { name: 'name', type: 'string' },
                        { name: 'created_date', type: 'date' },
                    ],
                    location: `s3://${queryResultsBucket.bucketName}/data/`,
                    inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
                    outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
                    serdeInfo: {
                        serializationLibrary: 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe',
                    },
                },
            },
        });
        glueTable.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Athena workgroup
        const athenaWorkgroup = new athena.CfnWorkGroup(this, 'AndesWorkgroup', {
            name: `andes-workgroup-${this.account}-${this.region}`,
            workGroupConfiguration: {
                resultConfiguration: {
                    outputLocation: `s3://${queryResultsBucket.bucketName}/results/`,
                },
                enforceWorkGroupConfiguration: true,
            },
        });
        athenaWorkgroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Lambda function to execute Athena queries
        const queryExecutorFunctionLogGroup = new logs.LogGroup(this, 'QueryExecutorFunctionLogGroup', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const queryExecutorFunction = new lambda.Function(this, 'QueryExecutorFunction', {
            logGroup: queryExecutorFunctionLogGroup,
            runtime: lambda.Runtime.PYTHON_3_11,
            handler: 'index.handler',
            code: lambda.Code.fromInline(`
import boto3
import json
import time

def handler(event, context):
    athena = boto3.client('athena')
    
    queries = [
        "SELECT COUNT(*) FROM andes_3_0_db.andes_3_0_data",
        "SELECT name, created_date FROM andes_3_0_db.andes_3_0_data LIMIT 10"
    ]
    
    workgroup = "${athenaWorkgroup.ref}"
    results = []
    
    for i, query in enumerate(queries):
        response = athena.start_query_execution(
            QueryString=query,
            WorkGroup=workgroup
        )
        
        query_id = response['QueryExecutionId']
        results.append({'query': i + 1, 'query_id': query_id, 'sql': query})
    
    return {'statusCode': 200, 'body': json.dumps(results)}
  `),
        });
        queryExecutorFunction.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Grant permissions
        queryExecutorFunction.addToRolePolicy(
            new iam.PolicyStatement({
                actions: [
                    'athena:StartQueryExecution',
                    'athena:GetQueryExecution',
                    'glue:GetTable',
                    'glue:GetDatabase',
                ],
                resources: ['*'],
            }),
        );
        queryResultsBucket.grantReadWrite(queryExecutorFunction);

        // Invoke Lambda on deploy
        new cr.AwsCustomResource(this, 'InvokeLambda', {
            onCreate: {
                service: 'Lambda',
                action: 'invoke',
                parameters: {
                    FunctionName: queryExecutorFunction.functionName,
                },
                physicalResourceId: cr.PhysicalResourceId.of('lambda-invoke'),
            },
            policy: cr.AwsCustomResourcePolicy.fromStatements([
                new iam.PolicyStatement({
                    actions: ['lambda:InvokeFunction'],
                    resources: [queryExecutorFunction.functionArn],
                }),
            ]),
        });

        // Output stack information
        StackUtils.exportStack(this, 'DatabaseName', andesDatabase.ref);
        StackUtils.exportStack(this, 'WorkgroupName', athenaWorkgroup.ref);
        StackUtils.exportStack(this, 'QueryResultsBucket', queryResultsBucket.bucketName);
        StackUtils.exportStack(this, 'LambdaFunctionName', queryExecutorFunction.functionName);
    }
}
