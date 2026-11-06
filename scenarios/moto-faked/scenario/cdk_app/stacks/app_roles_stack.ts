import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StackUtils } from '../lib/shared';

/*
* Stack ID: approles
*
* What the stack does:
* 1. Creates ApplicationReadOnlyRole (introspection tasks): read-only Get,
*    Describe and non-destructive Receive actions on the scenario resources.
* 2. Creates ApplicationAdminRole (mutation tasks): full data-plane write on
*    the scenario resources plus the read set.
*
* Both roles are assumable by the account root so the framework can hand
* them to the agent container per task.
*/

export class AppRolesStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const readActions = [
            's3:GetObject',
            's3:ListBucket',
            'sqs:GetQueueAttributes',
            'sqs:GetQueueUrl',
            'sqs:ReceiveMessage',
            'dynamodb:GetItem',
            'dynamodb:Query',
            'dynamodb:Scan',
            'dynamodb:DescribeTable',
        ];
        const writeActions = [
            ...readActions,
            's3:PutObject',
            's3:DeleteObject',
            'sqs:SendMessage',
            'sqs:PurgeQueue',
            'dynamodb:PutItem',
            'dynamodb:UpdateItem',
            'dynamodb:DeleteItem',
        ];

        const reader = new iam.Role(this, 'ApplicationReadOnlyRole', {
            roleName: 'ApplicationReadOnlyRole',
            assumedBy: new iam.AccountRootPrincipal(),
            inlinePolicies: {
                'order-read': new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: readActions,
                            resources: ['*'],
                        }),
                    ],
                }),
            },
        });

        const writer = new iam.Role(this, 'ApplicationAdminRole', {
            roleName: 'ApplicationAdminRole',
            assumedBy: new iam.AccountRootPrincipal(),
            inlinePolicies: {
                'order-write': new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: writeActions,
                            resources: ['*'],
                        }),
                    ],
                }),
            },
        });

        StackUtils.exportStack(this, 'ApplicationReadOnlyRoleArn', reader.roleArn, 'ARN of the read-only agent role');
        StackUtils.exportStack(this, 'ApplicationAdminRoleArn', writer.roleArn, 'ARN of the write-capable agent role');
    }
}
