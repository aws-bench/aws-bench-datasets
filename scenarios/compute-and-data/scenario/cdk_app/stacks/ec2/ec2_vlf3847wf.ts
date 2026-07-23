import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: ec2_vlf3847wf
 *
 * Prerequisites:
 *
 * Configure "env" with an account and region when you define your stack and deploy it
 *
 * The stack creates the following resources:
 *
 * 1. 1 VPC lookup (default VPC)
 * 2. 1 IAM Role (EKS service role)
 *
 */

export class ec2_vlf3847wf extends cdk.Stack {
    private readonly accountId: string;
    private readonly awsRegion: string;
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);
        this.accountId = this.account;
        this.awsRegion = this.region;

        // Use default VPC with multi-AZ subnets
        const vpc = ec2.Vpc.fromLookup(this, 'DefaultVPC', {
            isDefault: true,
        });

        // Create EKS service role without required policies
        const eksServiceRole = new iam.Role(this, 'EKSServiceRole', {
            assumedBy: new iam.ServicePrincipal('eks.amazonaws.com'),
        });
        eksServiceRole.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Export stack information
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId);
        StackUtils.exportStack(this, 'SubnetId1', vpc.publicSubnets[0].subnetId);
        StackUtils.exportStack(this, 'SubnetId2', vpc.publicSubnets[1].subnetId);
        StackUtils.exportStack(this, 'EKSServiceRoleName', eksServiceRole.roleName);
        StackUtils.exportStack(this, 'AWSRegion', this.awsRegion);
    }
}
