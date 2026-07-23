import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import { StackUtils } from '../../lib/shared';
import { RemovalPolicy } from 'aws-cdk-lib';

const num_subscribers = 2;

/*
* Stack ID: sqs-e5ldy6q5p

* What the stack does:
1. The stack creates a SNS topic.
2. Creates two SQS queue.
3. Subscribes the SQS queues to the SNS topic.
*/

export class SQS_e5ldy6q5p extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);


        // Create a SNS topic
        const topic = new sns.Topic(this, 'SNSTopic', {
            topicName: `inventory-updates-${this.account}-${this.region}`,
        });
        topic.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // Create an SQS queue
        const queue1 = new sqs.Queue(this, 'SQSQueue1', {
            queueName: `queue-1-${this.account}-${this.region}`,
        });
        queue1.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // Create an SQS queue
        const queue2 = new sqs.Queue(this, 'SQSQueue2', {
            queueName: `queue-2-${this.account}-${this.region}`,
        });
        queue2.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // Subscribe the SQS queues to the SNS topic
        topic.addSubscription(new subscriptions.SqsSubscription(queue1));
        topic.addSubscription(new subscriptions.SqsSubscription(queue2));

        // Output the ARNs of the created resources
        StackUtils.exportStack(this, 'NUMSubscribers', num_subscribers.toString(), 'The number of SNS topics');

        StackUtils.exportStack(this, 'Topic1Name', topic.topicArn, 'The ARN of the SNS topic 1');

        StackUtils.exportStack(this, 'QueueName', queue1.queueArn, 'The ARN of the SQS queue');

        StackUtils.exportStack(this, 'SecondQueueName', queue2.queueArn, 'The ARN of the second SQS queue');
    }
}
