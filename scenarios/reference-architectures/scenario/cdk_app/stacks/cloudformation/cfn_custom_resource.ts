import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * CloudFormation Custom Resource Stack
 *
 * Converted from aws-cdk-examples/typescript/custom-resource
 *
 * Creates:
 * 1. Lambda Singleton Function (Python 3.12) as custom resource handler
 * 2. Custom Resources Provider
 * 3. Custom Resource that echoes a message back via response attributes
 */

export class CfnCustomResourceStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const fn = new lambda.SingletonFunction(this, 'CustomResourceHandler', {
            uuid: 'f7d4f730-4ee1-11e8-9c2d-fa7ae01bbebc',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/cfn-custom-resource-handler')),
            handler: 'index.main',
            timeout: cdk.Duration.seconds(300),
            runtime: lambda.Runtime.PYTHON_3_12,
        });

        const provider = new cr.Provider(this, 'Provider', {
            onEventHandler: fn,
        });

        const resource = new cdk.CustomResource(this, 'Resource', {
            serviceToken: provider.serviceToken,
            properties: {
                message: `Hello from custom resource in ${this.account}-${this.region}`,
            },
        });

        StackUtils.exportStack(this, 'FunctionName', fn.functionName, 'Custom resource handler function name');
        StackUtils.exportStack(this, 'CustomResourceResponse', resource.getAttString('Response'), 'Response from custom resource');
        StackUtils.exportStack(this, 'ServiceToken', provider.serviceToken, 'Custom resource provider service token');
    }
}
