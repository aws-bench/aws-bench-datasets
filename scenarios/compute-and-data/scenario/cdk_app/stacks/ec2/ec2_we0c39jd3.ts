import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: ec2_we0c39jd3
 * What the stack does:
 * 1. Creates IPAM instance
 * 2. Creates private scope
 * 3. Creates public scope
 * 4. Creates IPAM pool in private scope with provisioned CIDR
 */

export class ec2_we0c39jd3 extends cdk.Stack {
    private readonly accountId: string;

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        this.accountId = this.account;

        // Create IPAM instance
        const ipam = new ec2.CfnIPAM(this, 'IPAM', {
            description: 'AWS IPAM for network management',
            operatingRegions: [{ regionName: this.region }],
            // Advanced tier releases a deleted VPC's pool allocation in minutes; the
            // default free tier can take up to 48h, too long for teardown to converge.
            tier: 'advanced',
        });

        ipam.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Create private scope
        const privateScope = new ec2.CfnIPAMScope(this, 'PrivateScope', {
            ipamId: ipam.attrIpamId,
            description: 'Private IP address scope',
        });

        privateScope.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Create public scope
        const publicScope = new ec2.CfnIPAMScope(this, 'PublicScope', {
            ipamId: ipam.attrIpamId,
            description: 'Public IP address scope',
        });

        publicScope.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Create IPAM pool in private scope with provisioned CIDR
        const privatePool = new ec2.CfnIPAMPool(this, 'PrivatePool', {
            ipamScopeId: privateScope.attrIpamScopeId,
            addressFamily: 'ipv4',
            description: 'Private IPAM pool for VPC allocation',
            provisionedCidrs: [
                {
                    cidr: '10.0.0.0/8',
                },
            ],
        });

        privatePool.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        StackUtils.exportStack(this, 'IPAMId', ipam.attrIpamId, 'IPAM ID');
        StackUtils.exportStack(this, 'PrivatePoolId', privatePool.attrIpamPoolId, 'Private pool ID');
    }
}
