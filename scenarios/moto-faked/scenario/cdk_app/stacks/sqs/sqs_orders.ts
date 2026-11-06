import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
* Stack ID: sqs-orders
*
* What the stack does:
* 1. Creates the `order-events` queue that buffers validated order events.
* 2. Creates the `order-events-dlq` dead-letter queue.
* 3. Wires a redrive policy: after 3 failed receives a message moves to
*    the DLQ (the threshold introspection task 02 asks about).
*/

export const MAX_RECEIVE_COUNT = 3;

export class SqsOrders extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const dlq = new sqs.Queue(this, 'OrderEventsDlq', {
            retentionPeriod: cdk.Duration.days(14),
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const queue = new sqs.Queue(this, 'OrderEvents', {
            visibilityTimeout: cdk.Duration.seconds(60),
            retentionPeriod: cdk.Duration.days(4),
            deadLetterQueue: {
                queue: dlq,
                maxReceiveCount: MAX_RECEIVE_COUNT,
            },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        StackUtils.exportStack(this, 'OrderQueueUrl', queue.queueUrl, 'URL of the order-events queue');
        StackUtils.exportStack(this, 'OrderQueueArn', queue.queueArn, 'ARN of the order-events queue');
        StackUtils.exportStack(this, 'OrderDlqUrl', dlq.queueUrl, 'URL of the order-events DLQ');
        StackUtils.exportStack(this, 'OrderDlqArn', dlq.queueArn, 'ARN of the order-events DLQ');
        StackUtils.exportStack(this, 'MaxReceiveCount', MAX_RECEIVE_COUNT.toString(), 'Redrive maxReceiveCount');
    }
}
