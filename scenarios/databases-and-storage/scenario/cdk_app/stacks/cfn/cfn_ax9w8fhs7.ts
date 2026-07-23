import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
* Stack ID: CFN_ax9w8fhs7

* What the stack does:
1. Creates one S3 bucket with deletion policy,
2. Creates one DynamoDB table with deletion policy,
3. Creates one VPC for the RDS DB Instance,
4. Creates one RDS DB Instance with deletion policy.
*/

export class CFN_ax9w8fhs7 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);


        // 1. S3 Bucket with DESTROY policy
        const bucket = new s3.Bucket(this, 'S3Bucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: false,
            encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
        });

        // 2. DynamoDB Table with DESTROY policy
        const table = new dynamodb.Table(this, 'DynamoDBTable', {
            tableName: `table-${this.account}-${this.region}`,
            partitionKey: {
                name: 'id',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // First create a VPC for the RDS instance
        const vpc = new ec2.Vpc(this, 'MyVPC', {
            maxAzs: 2,
        });

        // 3. RDS Instance with DESTROY policy
        const database = new rds.DatabaseInstance(this, 'RDSInstance', {
            engine: rds.DatabaseInstanceEngine.mysql({
                version: rds.MysqlEngineVersion.VER_8_0,
            }),
            vpc,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            databaseName: `MyDatabase`,
            instanceIdentifier: `database-${this.account}-${this.region}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            deletionProtection: false,
            deleteAutomatedBackups: true,
            allocatedStorage: 20,
            storageType: rds.StorageType.GP2,
            multiAz: false,
            publiclyAccessible: false,
            maxAllocatedStorage: 20,
        });

        StackUtils.exportStack(
            this,
            'RDSDBInstanceIdentifier',
            database.instanceIdentifier,
            'RDS database instance name',
        );

        StackUtils.exportStack(this, 'S3BucketName', bucket.bucketName, 'The name of the S3 bucket');

        StackUtils.exportStack(this, 'DynamoDBTableName', table.tableName, 'The name of the DynamoDB table');
    }
}
