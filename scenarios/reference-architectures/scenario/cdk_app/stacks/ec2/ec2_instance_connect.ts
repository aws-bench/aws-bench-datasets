import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack: Ec2InstanceConnect
 *
 * Converted from aws-cdk-examples/typescript/ec2-instance-connect-endpoint.
 * Creates a VPC with private isolated subnets, an EC2 instance, and an
 * Instance Connect Endpoint for secure access without public IPs.
 *
 * Resources created:
 * 1. VPC (10.0.0.0/16, 2 AZs, PRIVATE_ISOLATED subnets only)
 * 2. Security Group (all traffic from VPC CIDR)
 * 3. IAM Role with AmazonSSMManagedInstanceCore
 * 4. EC2 Instance (t3.micro, Amazon Linux 2023, private subnet)
 * 5. EC2 Instance Connect Endpoint (CfnInstanceConnectEndpoint)
 */

export class Ec2InstanceConnect extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // VPC: 10.0.0.0/16, 2 AZs, PRIVATE_ISOLATED subnets only
        const vpc = new ec2.Vpc(this, 'InstanceConnectVpc', {
            ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'PrivateIsolated',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                },
            ],
        });

        // Security Group: allow all traffic from VPC CIDR
        const securityGroup = new ec2.SecurityGroup(this, 'InstanceConnectSG', {
            vpc,
            description: 'Security group for EC2 Instance Connect - VPC traffic only',
            allowAllOutbound: true,
        });
        securityGroup.addIngressRule(
            ec2.Peer.ipv4('10.0.0.0/16'),
            ec2.Port.allTraffic(),
            'Allow all traffic from VPC CIDR',
        );

        // IAM Role with SSM managed policy
        const role = new iam.Role(this, 'InstanceConnectRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
            ],
        });

        // EC2 Instance (t3.micro, Amazon Linux 2023, private subnet)
        const instance = new ec2.Instance(this, 'InstanceConnectHost', {
            vpc,
            role,
            securityGroup,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: ec2.MachineImage.latestAmazonLinux2023(),
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            requireImdsv2: true,
        });
        instance.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Instance Connect Endpoint (L1 construct)
        const instanceConnectEndpoint = new ec2.CfnInstanceConnectEndpoint(this, 'InstanceConnectEndpoint', {
            subnetId: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds[0],
            securityGroupIds: [securityGroup.securityGroupId],
            preserveClientIp: false,
        });

        // Exports
        StackUtils.exportStack(this, 'InstanceId', instance.instanceId, 'EC2 instance ID');
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'VPC ID');
        StackUtils.exportStack(this, 'SubnetType', 'PRIVATE_ISOLATED', 'Subnet type used for the instance');
        StackUtils.exportStack(this, 'SecurityGroupId', securityGroup.securityGroupId, 'Security group ID');
        StackUtils.exportStack(
            this,
            'InstanceConnectEndpointId',
            instanceConnectEndpoint.attrId,
            'Instance Connect Endpoint ID',
        );
        StackUtils.exportStack(this, 'InstanceType', 't3.micro', 'EC2 instance type');
    }
}
