import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
* Stack ID: ddb-orders
*
* What the stack does:
* 1. Creates the `orders` table: partition key `orderId` (string),
*    pay-per-request billing. One item per order; `status` tracks the
*    order lifecycle (PENDING -> CONFIRMED).
*/

export class DdbOrders extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const table = new dynamodb.Table(this, 'OrdersTable', {
            partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        StackUtils.exportStack(this, 'OrdersTableName', table.tableName, 'Name of the orders table');
        StackUtils.exportStack(this, 'OrdersTableArn', table.tableArn, 'ARN of the orders table');
    }
}
