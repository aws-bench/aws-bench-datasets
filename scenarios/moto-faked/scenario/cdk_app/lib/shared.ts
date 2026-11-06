import * as cdk from 'aws-cdk-lib';

export interface EnvironmentProps {
    readonly account: string;
}

export class StackUtils {
    static exportStack(stack: cdk.Stack, name: string, value: string, description?: string): cdk.CfnOutput {
        return new cdk.CfnOutput(stack, name, {
            value,
            exportName: `${stack.stackName}-${name}`,
            description,
        });
    }
}
