import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: ec2_abcdefclj
 * What the stack does:
 * 1. Re-exports IPAM ID from ec2_we0c39jd3 for test case compatibility
 * Note: Scopes/pools removed due to quota limits (5/5 scopes per IPAM)
 */

export class ec2_abcdefclj extends cdk.Stack {
    private readonly accountId: string | undefined;
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        this.accountId = this.account;

        // Use existing IPAM from ec2_we0c39jd3 stack to avoid quota limits
        const ipamId = cdk.Fn.importValue(`compute-and-data-ec2-we0c39jd3-us-east-1-IPAMId`);

        // Export the IPAM ID for test case compatibility
        // Test case only needs IPAM ID to create external resource verification tokens
        StackUtils.exportStack(this, 'IPAMId', ipamId, 'IPAM ID (shared from ec2_we0c39jd3)');
    }
}
