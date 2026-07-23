import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { RemovalPolicy } from 'aws-cdk-lib';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: ec2_ydhdiehs5
 * What the stack does:
 * 1. Creates VPCs
 * 2. Creates Security group
 * 3. Creates IAM role
 * 4. Creates a EC2 instance
 * */

export class ec2_ydhdiehs5 extends cdk.Stack {
    private readonly accountId: string;

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        this.accountId = this.account;

        // Transit VPC (with IGW for SSH access)
        const transitVpc = new ec2.Vpc(this, 'TransitVpc', {
            cidr: '10.1.0.0/16',
            maxAzs: 2,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'TransitPublic',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
            ],
            natGateways: 0,
        });
        transitVpc.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // VPC-A (Private isolated)
        const vpcA = new ec2.Vpc(this, 'VpcA', {
            cidr: '10.2.0.0/16',
            maxAzs: 2,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'PrivateA',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                },
            ],
            natGateways: 0,
        });
        vpcA.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // VPC-D (Overlapping CIDR with VPC-A)
        const vpcD = new ec2.Vpc(this, 'VpcD', {
            cidr: '10.2.0.0/16',
            maxAzs: 2,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'PrivateD',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                },
            ],
            natGateways: 0,
        });
        vpcD.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // Security Group for Transit EC2
        const transitSG = new ec2.SecurityGroup(this, 'TransitSG', {
            vpc: transitVpc,
            description: 'Allow SSH and VXLAN',
            allowAllOutbound: true,
        });
        transitSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'SSH Access');
        transitSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(4789), 'VXLAN Traffic');
        transitSG.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // IAM Role for EC2
        const ec2Role = new iam.Role(this, 'TransitRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2FullAccess')],
        });
        ec2Role.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // Transit EC2 Instance
        const transitInstance = new ec2.Instance(this, 'TransitInstance', {
            vpc: transitVpc,
            instanceType: new ec2.InstanceType('t3.medium'),
            machineImage: ec2.MachineImage.latestAmazonLinux2023(),
            securityGroup: transitSG,
            role: ec2Role,
            sourceDestCheck: false, // Required for routing
            requireImdsv2: true,
        });
        transitInstance.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // Outputs
        StackUtils.exportStack(this, 'TransitVpcId', transitVpc.vpcId, 'Transit Vpc Id');
        StackUtils.exportStack(this, 'VpcAId', vpcA.vpcId, 'VpcA Id');
        StackUtils.exportStack(this, 'VpcDId', vpcD.vpcId, 'VpcD Id');
        StackUtils.exportStack(this, 'TransitInstanceId', transitInstance.instanceId, 'TransitInstanceId');
    }
}
