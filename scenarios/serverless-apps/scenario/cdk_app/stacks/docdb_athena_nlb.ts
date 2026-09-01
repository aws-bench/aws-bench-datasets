import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as docdb from 'aws-cdk-lib/aws-docdb';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { StackUtils } from '../lib/shared';

export interface DocDbAthenaNlbStackProps extends cdk.StackProps {
    vpc: ec2.IVpc;
}

export class DocDbAthenaNlbStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: DocDbAthenaNlbStackProps) {
        super(scope, id, props);

        const { vpc } = props;

        // Create DocumentDB cluster
        const docDBCluster = new docdb.DatabaseCluster(this, 'my-recommendation-engine', {
            masterUser: {
                username: 'appadmin',
            },
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
            vpc,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        docDBCluster.node.addDependency(vpc);

        // Create Athena workgroup and related resources
        const analysisDataBucket = new s3.Bucket(this, 'athena-analytics-data-bucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            enforceSSL: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
        });

        const featureStoreTable = new dynamodb.Table(this, 'my-feature-store', {
            partitionKey: { name: 'featureId', type: dynamodb.AttributeType.STRING },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        });

        const athenaWorkgroup = new athena.CfnWorkGroup(this, 'my-data-science-workgroup', {
            name: 'my-data-science-workgroup',
            workGroupConfiguration: {
                resultConfiguration: {
                    outputLocation: `s3://${analysisDataBucket.bucketName}/athena-results/`,
                },
            },
        });

        // Create the S3 bucket for NLB logging
        const loggingBucket = new s3.Bucket(this, 'InternalNLBLoggingBucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
        });
        const internalNLB = new elbv2.NetworkLoadBalancer(this, 'InternalNLB', {
            vpc,
            internetFacing: false,
            loadBalancerName: 'InternalNLB',
            vpcSubnets: {
                subnets: vpc.privateSubnets,
            },
        });
        internalNLB.logAccessLogs(loggingBucket);

        // DynamoDB tables
        const salesDataTable = new dynamodb.Table(this, 'SalesDataTable', {
            tableName: 'mySalesData',
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Data Processor Lambda
        const notificationsTopic = sns.Topic.fromTopicArn(
            this,
            'NotificationsTopic',
            'arn:aws:sns:us-west-2:123456789012:my-notifications',
        );

        const salesHistoryTable = new dynamodb.Table(this, 'SalesHistoryTable', {
            tableName: 'mySalesHistory',
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const dataProcessorLambdaLogGroup = new logs.LogGroup(this, 'DataProcessorLambdaLogGroup', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const dataProcessorLambda = new lambda.Function(this, 'DataProcessorLambda', {
            logGroup: dataProcessorLambdaLogGroup,
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: new lambda.InlineCode('exports.handler = async (event) => console.log(event)'),
            vpc,
        });

        const processedDataBucket = s3.Bucket.fromBucketName(this, 'ProcessedDataBucket', 'processed-data-bucket');
        processedDataBucket.grantReadWrite(dataProcessorLambda);
        salesDataTable.grantReadWriteData(dataProcessorLambda);
        salesHistoryTable.grantReadWriteData(dataProcessorLambda);
        notificationsTopic.grantPublish(dataProcessorLambda);

        // Exports
        StackUtils.exportStack(this, 'InternalNLBName', internalNLB.loadBalancerFullName);
        StackUtils.exportStack(this, 'InternalNLBAccessLoggingBucketName', loggingBucket.bucketName);

        StackUtils.exportStack(this, 'DocDbClusterName', docDBCluster.clusterIdentifier);
        StackUtils.exportStack(this, 'DocDbClusterEndpoint', docDBCluster.clusterEndpoint.hostname);
        StackUtils.exportStack(
            this,
            'DocDbClusterArn',
            `arn:aws:rds:${this.region}:${this.account}:clusterIdentifier:${docDBCluster.clusterIdentifier}`,
            '',
        );
        StackUtils.exportStack(
            this,
            'DocDbSecurityGroupId',
            docDBCluster.connections.securityGroups[0].securityGroupId,
            '',
        );

        // Athena Resources Exports
        StackUtils.exportStack(this, 'AnalysisDataBucketName', analysisDataBucket.bucketName);
        StackUtils.exportStack(this, 'AnalysisDataBucketArn', analysisDataBucket.bucketArn);
        StackUtils.exportStack(this, 'AthenaWorkgroupName', athenaWorkgroup.name);
        StackUtils.exportStack(
            this,
            'AthenaOutputLocation',
            `s3://${analysisDataBucket.bucketName}/athena-results/`,
            '',
        );

        StackUtils.exportStack(this, 'MyDataProcessorLambda', dataProcessorLambda.functionName);
        StackUtils.exportStack(this, 'MySalesDataTable', salesDataTable.tableName);
    }
}
