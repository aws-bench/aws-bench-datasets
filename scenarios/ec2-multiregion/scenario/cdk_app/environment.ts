import * as cdk from 'aws-cdk-lib';
import { EnvironmentProps } from './lib/shared';
import { EC2_ks84v1fh12 } from './stacks/ec2_ks84v1fh1';
import { EC2_ls9fuhb522 } from './stacks/ec2_ls9fuhb52';
import { QARolesStack } from './stacks/qa_roles_stack';

export function createEnvironment(app: cdk.App, envId: string, props: EnvironmentProps): void {
    new QARolesStack(app,   `${envId}-QARoles-us-east-1`,        { env: { account: props.account, region: 'us-east-1' } });
    new EC2_ks84v1fh12(app, `${envId}-EC2-ks84v1fh12-us-east-1`, { env: { account: props.account, region: 'us-east-1' } });
    new EC2_ls9fuhb522(app, `${envId}-EC2-ls9fuhb522-us-west-1`, { env: { account: props.account, region: 'us-west-1' } });
    new EC2_ls9fuhb522(app, `${envId}-EC2-ls9fuhb522-us-west-2`, { env: { account: props.account, region: 'us-west-2' } });
}
