import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

export class IAM_e71d403fc extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        new ssm.StringParameter(this, 'TigrisDeploymentConfig', {
            parameterName: '/tigris/e71d403fc/deployment-status',
            stringValue: 'pending',
        });

        StackUtils.exportStack(
            this,
            'FailedStackName',
            'api-and-observability-TigrisService-e71d403fc-us-east-1',
            'Stack name',
        );

        StackUtils.exportStack(
            this,
            'FailedWorkerStackName',
            'api-and-observability-TigrisWorker-e71d403fc-us-east-1',
            'Worker stack name',
        );
    }
}
