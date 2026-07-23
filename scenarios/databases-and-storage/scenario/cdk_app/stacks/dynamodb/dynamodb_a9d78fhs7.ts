import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
* Stack ID: DynamoDB_a9d78fhs7

* What the stack does:
1. The stack creates a Kinesis Data Stream,
2. Creates one DynamoDB table with Kinesis Stream configuration,
3. Creates one more DynamoDB table,
4. Create one IAM user,
5. Creates one Resource Based Policy using the IAM user,
6. Creats AWS Custom Resource to add the policy to the second DynamoDB table.
*/

export class DynamoDB_a9d78fhs7 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);


        const billingMode1 = dynamodb.BillingMode.PAY_PER_REQUEST;
        const billingMode2 = dynamodb.BillingMode.PROVISIONED;

        // Create a Kinesis stream
        const kinesisStream = new kinesis.Stream(this, 'MyKinesisStream', {
            streamName: `stream-${this.account}-${this.region}`,
            shardCount: 1, // Adjust based on your throughput needs
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Create DynamoDB table with Kinesis stream configuration
        const table1 = new dynamodb.Table(this, 'TableWithStream', {
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            tableName: `table1-${this.account}-${this.region}`,
            billingMode: billingMode2,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            kinesisStream: kinesisStream, // Configure the Kinesis stream
        });

        // Create the DynamoDB table to have resource policy
        const table2 = new dynamodb.Table(this, 'TableWithPolicy', {
            tableName: `table2-${this.account}-${this.region}`,
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            billingMode: billingMode1,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // First, create the IAM user
        const ddbUser = new iam.User(this, 'DynamoDBUser', {
            userName: `user-${this.account}-${this.region}`,
        });

        // Create the resource-based policy
        const resourcePolicy = new iam.PolicyDocument({
            statements: [
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    principals: [new iam.ArnPrincipal(ddbUser.userArn)],
                    actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
                    resources: [table2.tableArn],
                }),
            ],
        });

        // Create the AWS Custom Resource
        new cr.AwsCustomResource(this, 'TableResourcePolicy', {
            onCreate: {
                service: 'DynamoDB',
                action: 'putResourcePolicy',
                parameters: {
                    ResourceArn: table2.tableArn,
                    Policy: JSON.stringify(resourcePolicy.toJSON()), // Stringify the policy
                },
                physicalResourceId: cr.PhysicalResourceId.of(`${table2.tableArn}-policy`),
            },
            onUpdate: {
                service: 'DynamoDB',
                action: 'putResourcePolicy',
                parameters: {
                    ResourceArn: table2.tableArn,
                    Policy: JSON.stringify(resourcePolicy.toJSON()), // Stringify the policy
                },
                physicalResourceId: cr.PhysicalResourceId.of(`${table2.tableArn}-policy`),
            },
            onDelete: {
                service: 'DynamoDB',
                action: 'deleteResourcePolicy',
                parameters: {
                    ResourceArn: table2.tableArn,
                },
            },
            policy: cr.AwsCustomResourcePolicy.fromStatements([
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['dynamodb:PutResourcePolicy', 'dynamodb:DeleteResourcePolicy'],
                    resources: [table2.tableArn],
                }),
            ]),
        });

        StackUtils.exportStack(this, 'DynamoDBTableWithStream', table1.tableName);
        StackUtils.exportStack(this, 'DynamoDBTableTableWithPolicy', table2.tableName);
        StackUtils.exportStack(this, 'DynamoDBTableWithWarmThroughput1', table1.tableName);
        StackUtils.exportStack(this, 'DynamoDBTableWithWarmThroughput2', table2.tableName);
        StackUtils.exportStack(this, 'ProvisionedBillingMode', billingMode2, 'The type of the Billing Mode');
        StackUtils.exportStack(this, 'PayPerRequestBillingMode', billingMode1, 'The type of the Billing Mode');
        StackUtils.exportStack(this, 'DDBUser', ddbUser.userName, 'The name of the DynamoDB user');
    }
}
