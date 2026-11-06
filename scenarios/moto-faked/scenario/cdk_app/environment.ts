import * as cdk from 'aws-cdk-lib';
import { EnvironmentProps } from './lib/shared';
import { AppRolesStack } from './stacks/app_roles_stack';
import { S3Orders } from './stacks/s3/s3_orders';
import { SqsOrders } from './stacks/sqs/sqs_orders';
import { DdbOrders } from './stacks/dynamodb/ddb_orders';

export function createEnvironment(app: cdk.App, envId: string, props: EnvironmentProps): void {
    new AppRolesStack(app, `${envId}-approles-us-east-1`, { env: { account: props.account, region: 'us-east-1' } });
    new S3Orders(app, `${envId}-s3-orders-us-east-1`, { env: { account: props.account, region: 'us-east-1' } });
    new SqsOrders(app, `${envId}-sqs-orders-us-east-1`, { env: { account: props.account, region: 'us-east-1' } });
    new DdbOrders(app, `${envId}-ddb-orders-us-east-1`, { env: { account: props.account, region: 'us-east-1' } });
}
