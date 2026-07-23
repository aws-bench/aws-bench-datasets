import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: cloudformation-ne1y5vgir
 *
 * 8e01db45-f20d-4b54-868b-613cfb7e7665_186_212
 *
 * Creates a VPC with subnets for EKS and application workloads.
 */

export class Cloudformation_ne1y5vgir extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const vpc = new ec2.Vpc(this, 'MainVpc', {
            vpcName: `main-vpc-${this.account}-${this.region}`,
            ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'public',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
            ],
        });

        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'The ID of the main VPC');
        StackUtils.exportStack(this, 'PublicSubnet1Id', vpc.publicSubnets[0].subnetId, 'Public subnet 1 ID');
        StackUtils.exportStack(this, 'PublicSubnet2Id', vpc.publicSubnets[1].subnetId, 'Public subnet 2 ID');
    }
}
