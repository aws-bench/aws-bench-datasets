import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { StackUtils } from '../lib/shared';

export interface DatabaseStackProps extends cdk.StackProps {
    vpc: ec2.IVpc;
}

export class DatabaseStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: DatabaseStackProps) {
        super(scope, id, props);

        const { vpc } = props;

        // Create RDS instance for storage space monitoring
        const allocatedStorageRDS = 20;
        const rdsInstance = new rds.DatabaseInstance(this, 'TestRDS', {
            engine: rds.DatabaseInstanceEngine.MYSQL,
            vpc,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            allocatedStorage: allocatedStorageRDS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        rdsInstance.node.addDependency(vpc);

        // Export RDS instance
        StackUtils.exportStack(this, 'RdsEndpointAllocatedStorage', allocatedStorageRDS.toString());
        StackUtils.exportStack(this, 'RdsEndpoint', rdsInstance.instanceEndpoint.hostname);
        StackUtils.exportStack(this, 'RdsInstanceId', rdsInstance.instanceIdentifier);

        // Create DynamoDB tables
        const eventLogsTable = new dynamodb.Table(this, 'my-event-logs', {
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        });

        // Export DynamoDB table
        StackUtils.exportStack(this, 'EventLogsTableName', eventLogsTable.tableName);
        StackUtils.exportStack(this, 'EventLogsTableArn', eventLogsTable.tableArn);

        const customerOrdersTable = new dynamodb.Table(this, 'my-customer-orders', {
            partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        });

        // Export Customer Orders DynamoDB table
        StackUtils.exportStack(this, 'CustomerOrdersTableName', customerOrdersTable.tableName);
        StackUtils.exportStack(this, 'CustomerOrdersTableArn', customerOrdersTable.tableArn);
    }
}
