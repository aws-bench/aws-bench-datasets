import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { S3Orders } from '../stacks/s3/s3_orders';
import { SqsOrders } from '../stacks/sqs/sqs_orders';
import { DdbOrders } from '../stacks/dynamodb/ddb_orders';
import { AppRolesStack } from '../stacks/app_roles_stack';

// Offline grading leg 1: synthesize each stack and assert on the
// CloudFormation template. Runs with `npm test`; no AWS account needed.

const ACCOUNT = '123456789012';

function synth(ctor: new (scope: cdk.App, id: string, props: cdk.StackProps) => cdk.Stack, id: string): Template {
    const app = new cdk.App();
    const stack = new ctor(app, id, { env: { account: ACCOUNT, region: 'us-east-1' } });
    return Template.fromStack(stack);
}

describe('moto-faked scenario templates', () => {
    test('landing bucket is versioned with public access blocked', () => {
        const template = synth(S3Orders, 'moto-faked-s3-orders-us-east-1');
        template.hasResourceProperties('AWS::S3::Bucket', {
            VersioningConfiguration: { Status: 'Enabled' },
            PublicAccessBlockConfiguration: Match.objectLike({
                BlockPublicAcls: true,
            }),
        });
        template.hasOutput('LandingBucketName', {});
        template.hasOutput('LandingBucketArn', {});
    });

    test('order queue has a DLQ redrive policy with maxReceiveCount 3', () => {
        const template = synth(SqsOrders, 'moto-faked-sqs-orders-us-east-1');
        template.resourceCountIs('AWS::SQS::Queue', 2);
        template.hasResourceProperties('AWS::SQS::Queue', {
            RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
        });
        for (const out of ['OrderQueueUrl', 'OrderQueueArn', 'OrderDlqUrl', 'OrderDlqArn', 'MaxReceiveCount']) {
            template.hasOutput(out, {});
        }
    });

    test('orders table keys on orderId with pay-per-request billing', () => {
        const template = synth(DdbOrders, 'moto-faked-ddb-orders-us-east-1');
        template.hasResourceProperties('AWS::DynamoDB::Table', {
            KeySchema: [{ AttributeName: 'orderId', KeyType: 'HASH' }],
            BillingMode: 'PAY_PER_REQUEST',
        });
        template.hasOutput('OrdersTableName', {});
        template.hasOutput('OrdersTableArn', {});
    });

    test('reader and writer agent roles exist', () => {
        const template = synth(AppRolesStack, 'moto-faked-approles-us-east-1');
        template.resourceCountIs('AWS::IAM::Role', 2);
        template.hasOutput('ApplicationReadOnlyRoleArn', {});
        template.hasOutput('ApplicationAdminRoleArn', {});
    });

    test('every stack emits CloudFormation exports for task placeholders', () => {
        for (const [ctor, id] of [
            [S3Orders, 'moto-faked-s3-orders-us-east-1'],
            [SqsOrders, 'moto-faked-sqs-orders-us-east-1'],
            [DdbOrders, 'moto-faked-ddb-orders-us-east-1'],
            [AppRolesStack, 'moto-faked-approles-us-east-1'],
        ] as const) {
            const template = synth(ctor, id);
            const outputs = template.findOutputs('*');
            expect(Object.keys(outputs).length).toBeGreaterThan(0);
            for (const [, out] of Object.entries(outputs)) {
                expect((out as { Export?: { Name?: unknown } }).Export?.Name).toBeDefined();
            }
        }
    });
});
