import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: ec2-cc1xvkdie
 *
 * 0c1f61a4-bc71-40cf-8500-87fd997e299a
 *
 * What the stack does:
 * 1. Creates a VPC with default CIDR block (172.31.0.0/16)
 * 2. Creates a private subnet for app/db tier
 * 3. Creates security groups for app server and SSH access
 * 4. Creates a NAT Gateway for internet access from private subnet
 * 5. Creates a route table with routes to NAT Gateway
 * 6. Creates an IAM role for EC2 instance
 * 7. Creates an EC2 instance running Red Hat Enterprise Linux
 */

export class Ec2_cc1xvkdie extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // Create VPC with default CIDR block
        const vpc = new ec2.Vpc(this, 'FlintProdVpc', {
            ipAddresses: ec2.IpAddresses.cidr('172.31.0.0/16'),
            maxAzs: 1,
            natGateways: 0, // We'll create NAT Gateway manually
            subnetConfiguration: [], // We'll create subnets manually
            enableDnsHostnames: true,
            enableDnsSupport: true,
        });

        // Tag the VPC
        cdk.Tags.of(vpc).add('Managed resource', 'Garnet');

        // Create Internet Gateway for the VPC
        const internetGateway = new ec2.CfnInternetGateway(this, 'InternetGateway', {});

        // Attach Internet Gateway to VPC
        const vpcGatewayAttachment = new ec2.CfnVPCGatewayAttachment(this, 'VPCGatewayAttachment', {
            vpcId: vpc.vpcId,
            internetGatewayId: internetGateway.ref,
        });

        // Create public subnet for NAT Gateway (referenced in NAT Gateway properties)
        const publicSubnet = new ec2.PublicSubnet(this, 'PublicSubnet', {
            vpcId: vpc.vpcId,
            cidrBlock: '172.31.16.0/20',
            availabilityZone: 'us-west-2b',
            mapPublicIpOnLaunch: true,
        });

        // Create route to Internet Gateway for public subnet
        new ec2.CfnRoute(this, 'PublicSubnetDefaultRoute', {
            routeTableId: publicSubnet.routeTable.routeTableId,
            destinationCidrBlock: '0.0.0.0/0',
            gatewayId: internetGateway.ref,
        }).addDependency(vpcGatewayAttachment);

        // Create private subnet for app/db tier
        const privateSubnet = new ec2.PrivateSubnet(this, 'FlintProdSubnetPrivateAppDb', {
            vpcId: vpc.vpcId,
            cidrBlock: '172.31.0.0/20',
            availabilityZone: 'us-west-2b',
            mapPublicIpOnLaunch: false,
        });

        cdk.Tags.of(privateSubnet).add('Name', 'Flint-prod-subnet-private-app-db');

        // Create Elastic IP for NAT Gateway
        const eip = new ec2.CfnEIP(this, 'NatGatewayEIP', {
            domain: 'vpc',
        });

        // Create NAT Gateway in public subnet
        const natGateway = new ec2.CfnNatGateway(this, 'FlintProdNatGateway', {
            subnetId: publicSubnet.subnetId,
            allocationId: eip.attrAllocationId,
            connectivityType: 'public',
        });
        natGateway.addDependency(vpcGatewayAttachment);


        // Create Route Table for private subnet (use a separate one for better control)
        const routeTable = new ec2.CfnRouteTable(this, 'FlintProdPrivateSubnetRouteTable', {
            vpcId: vpc.vpcId,
            tags: [{ key: 'Name', value: 'Flint-prod-private-subnet-route-table' }],
        });

        // Add route to NAT Gateway
        new ec2.CfnRoute(this, 'RouteToNatGateway', {
            routeTableId: routeTable.ref,
            destinationCidrBlock: '0.0.0.0/0',
            natGatewayId: natGateway.ref,
        });

        // Associate route table with private subnet
        // Note: This will replace the default route table association created by PrivateSubnet
        new ec2.CfnSubnetRouteTableAssociation(this, 'PrivateSubnetRouteTableAssociation', {
            subnetId: privateSubnet.subnetId,
            routeTableId: routeTable.ref,
        });

        // Create Security Group for App Server
        const appServerSecurityGroup = new ec2.SecurityGroup(this, 'FlintProdSgAppServer', {
            vpc,
            description: 'App server security group',
            allowAllOutbound: true,
        });

        cdk.Tags.of(appServerSecurityGroup).add('Name', 'Flint-prod-sg-app-alb');

        // Add ingress rules to app server security group
        appServerSecurityGroup.addIngressRule(
            ec2.Peer.ipv4('172.31.0.0/20'),
            ec2.Port.tcp(8080),
            'Allow 8080 from subnet',
        );

        appServerSecurityGroup.addIngressRule(
            ec2.Peer.ipv4('10.0.2.32/32'),
            ec2.Port.tcp(22),
            'Private connection to prod server',
        );

        appServerSecurityGroup.addIngressRule(
            ec2.Peer.ipv4('10.0.3.2/32'),
            ec2.Port.tcp(22),
            'Private connection to prod server',
        );

        appServerSecurityGroup.addIngressRule(
            ec2.Peer.ipv4('10.0.3.2/32'),
            ec2.Port.allIcmp(),
            'Ping from prod server',
        );

        const albSecurityGroup = new ec2.SecurityGroup(this, 'FlintProdAlbSg', {
            vpc,
            securityGroupName: 'flint-prod-alb-sg',
            description: 'ALB security group',
        });
        cdk.Tags.of(albSecurityGroup).add('Name', 'Flint-prod-ALB-SG');

        appServerSecurityGroup.addIngressRule(
            albSecurityGroup,
            ec2.Port.tcp(8081),
            '',
        );

        // Create Security Group for SSH access
        const sshSecurityGroup = new ec2.SecurityGroup(this, 'FlintAllowProdCorpSsh', {
            vpc,
            description: 'Open ssh to corp',
            allowAllOutbound: true,
        });

        cdk.Tags.of(sshSecurityGroup).add('Name', 'Flint-prod-sg-app-ssh');

        // Add ingress rules for SSH
        sshSecurityGroup.addIngressRule(ec2.Peer.ipv4('10.0.0.0/20'), ec2.Port.tcp(22), 'SSH from corp network');

        sshSecurityGroup.addIngressRule(ec2.Peer.ipv4('10.0.16.0/23'), ec2.Port.tcp(22), 'SSH from corp network');

        // Add prefix list ingress rule
        sshSecurityGroup.addIngressRule(ec2.Peer.prefixList('pl-5aa44133'), ec2.Port.tcp(22), 'SSH from prefix list');

        // Create IAM Role for EC2 instance
        const ec2Role = new iam.Role(this, 'FlintOnyxAppServerRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            roleName: `FlintOnyxAppServerRole-${this.account}-${this.region}`,
            path: '/',
        });

        // Create Instance Profile
        const instanceProfile = new iam.CfnInstanceProfile(this, 'FlintOnyxInstanceProfile', {
            roles: [ec2Role.roleName],
            instanceProfileName: `FlintOnyxAppServerRole-${this.account}-${this.region}`,
            path: '/',
        });

        // Create EC2 Instance
        // Note: Using Red Hat Enterprise Linux with High Availability
        // We'll use a generic RHEL AMI - in production, you'd specify the exact AMI ID
        const machineImage = ec2.MachineImage.genericLinux({
            'us-west-2': 'ami-0c2ab3b8efb09f272', // RHEL 8 AMI (example)
        });

        const instance = new ec2.Instance(this, 'FlintOnyxAppServer', {
            vpc,
            vpcSubnets: {
                subnets: [privateSubnet],
            },
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage,
            securityGroup: appServerSecurityGroup,
            role: ec2Role,
            blockDevices: [
                {
                    deviceName: '/dev/sda1',
                    volume: ec2.BlockDeviceVolume.ebs(100, {
                        deleteOnTermination: true,
                        volumeType: ec2.EbsDeviceVolumeType.GP3,
                    }),
                },
                {
                    deviceName: '/dev/sdf',
                    volume: ec2.BlockDeviceVolume.ebs(100, {
                        deleteOnTermination: false,
                        volumeType: ec2.EbsDeviceVolumeType.GP3,
                    }),
                },
            ],
            detailedMonitoring: true,
            requireImdsv2: true,
        });

        // Add second security group to instance
        instance.addSecurityGroup(sshSecurityGroup);

        // Add tags to instance
        cdk.Tags.of(instance).add('Service', 'Flint-PLM');
        cdk.Tags.of(instance).add('AutoPatch', 'enabled');
        cdk.Tags.of(instance).add('Environment', 'prod');
        cdk.Tags.of(instance).add('Name', 'Flint-prod-Garnet - Onyx12.1');

        // Export stack outputs
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'The VPC ID');
        StackUtils.exportStack(this, 'PrivateSubnetId', privateSubnet.subnetId, 'The private subnet ID');
        StackUtils.exportStack(this, 'InstanceId', instance.instanceId, 'The EC2 instance ID');
        StackUtils.exportStack(this, 'InstancePrivateIp', instance.instancePrivateIp, 'The EC2 instance private IP');
        StackUtils.exportStack(
            this,
            'AppServerSecurityGroupId',
            appServerSecurityGroup.securityGroupId,
            'App server security group ID',
        );
        StackUtils.exportStack(
            this,
            'AlbSecurityGroupId',
            albSecurityGroup.securityGroupId,
            'ALB security group ID',
        );
        StackUtils.exportStack(
            this,
            'AlbSecurityGroupName',
            'flint-prod-alb-sg',
            'ALB security group name',
        );
        StackUtils.exportStack(this, 'SshSecurityGroupId', sshSecurityGroup.securityGroupId, 'SSH security group ID');
        StackUtils.exportStack(this, 'NatGatewayId', natGateway.ref, 'NAT Gateway ID');
        StackUtils.exportStack(this, 'RouteTableId', routeTable.ref, 'Route Table ID');
    }
}
