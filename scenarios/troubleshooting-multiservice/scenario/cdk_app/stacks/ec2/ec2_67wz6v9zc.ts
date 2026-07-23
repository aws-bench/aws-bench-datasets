import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { Stack as DeploymentStack, StackProps as DeploymentStackProps } from 'aws-cdk-lib';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: ec2-67wz6v9zc
 *
 * 66b1d023-e359-4cc7-8ea6-0ded100e7c55
 *
 * What the stack does:
 * 1. Creates a VPC with public subnet, internet gateway, and route table
 * 2. Creates security groups for jump server and RDS
 * 3. Creates an EC2 jump server instance with network interface
 * 4. Creates Network Load Balancer and Application Load Balancer
 */

export class Ec2_67wz6v9zc extends DeploymentStack {
    constructor(scope: Construct, id: string, props: DeploymentStackProps) {
        super(scope, id, props);

        // Create VPC
        const vpc = new ec2.Vpc(this, 'QaVpc', {
            vpcName: `garnet-qa-vpc-${this.account}-${this.region}`,
            ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    name: 'public',
                    subnetType: ec2.SubnetType.PUBLIC,
                    cidrMask: 24,
                },
                {
                    name: 'private',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                    cidrMask: 24,
                },
            ],
        });

        // Get the public subnet in us-east-1c (or first available)
        const publicSubnet = vpc.publicSubnets[0];

        // Create security group for RDS (referenced by jump server SG)
        const rdsSecurityGroup = new ec2.SecurityGroup(this, 'QaRdsSg', {
            vpc,
            securityGroupName: `qa-rds-security-group-${this.account}-${this.region}`,
            description: 'QA RDS SG',
            allowAllOutbound: true,
        });

        // Create security group for jump server
        const jumpServerSg = new ec2.SecurityGroup(this, 'JumpServerSg', {
            vpc,
            securityGroupName: `garnet-qa-rds-jump-server-sg-01-${this.account}-${this.region}`,
            description: 'Security group for QA jump server',
            allowAllOutbound: false,
        });

        // Add ingress rules for jump server SG
        // SSH from prefix lists (regional and production ranges)
        jumpServerSg.addIngressRule(ec2.Peer.prefixList('pl-60b85b09'), ec2.Port.tcp(22), 'Regional ranges for us-east-1');
        jumpServerSg.addIngressRule(ec2.Peer.prefixList('pl-f8bd5e91'), ec2.Port.tcp(22), 'Prod ranges for us-east-1');

        // Add egress rules for jump server SG
        jumpServerSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3306), 'MySQL to anywhere');
        jumpServerSg.addEgressRule(
            ec2.Peer.securityGroupId(rdsSecurityGroup.securityGroupId),
            ec2.Port.tcp(3306),
            'QA RDS SG',
        );
        jumpServerSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS to anywhere');

        // Create IAM role for EC2 instance
        const instanceRole = new iam.Role(this, 'JumpServerRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            roleName: `jump-server-role-${this.account}-${this.region}`,
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
        });

        // Create EC2 instance
        const jumpServer = new ec2.Instance(this, 'JumpServer', {
            instanceName: `qa-rds-jump-server-${this.account}-${this.region}`,
            vpc,
            vpcSubnets: {
                subnets: [publicSubnet],
            },
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: ec2.MachineImage.latestAmazonLinux2023(),
            securityGroup: jumpServerSg,
            role: instanceRole,
            associatePublicIpAddress: true,
            blockDevices: [
                {
                    deviceName: '/dev/xvda',
                    volume: ec2.BlockDeviceVolume.ebs(8, {
                        deleteOnTermination: true,
                        volumeType: ec2.EbsDeviceVolumeType.GP3,
                    }),
                },
            ],
        });

        // Configure metadata options
        const cfnInstance = jumpServer.node.defaultChild as ec2.CfnInstance;
        cfnInstance.addPropertyOverride('MetadataOptions', {
            HttpTokens: 'required',
            HttpPutResponseHopLimit: 1,
            HttpEndpoint: 'enabled',
        });

        // Get private subnets for load balancers
        const privateSubnets = vpc.isolatedSubnets.slice(0, 2);

        // Create security group for ALB
        const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSg', {
            vpc,
            securityGroupName: `garnet-qa-backend-alb-sg-${this.account}-${this.region}`,
            description: 'Security group for QA backend ALB',
            allowAllOutbound: true,
        });

        // Create Application Load Balancer
        // Load balancer name must be <= 32 characters (AWS limit)
        // Using environment ID for uniqueness: qa-alb-02-67wz6v9zc = 20 characters
        const alb = new elbv2.ApplicationLoadBalancer(this, 'QaBackendAlb', {
            loadBalancerName: `qa-alb-02-67wz6v9zc`,
            vpc,
            vpcSubnets: {
                subnets: privateSubnets,
            },
            internetFacing: false,
            securityGroup: albSecurityGroup,
            ipAddressType: elbv2.IpAddressType.IPV4,
        });

        // Create Network Load Balancer
        // Load balancer name must be <= 32 characters (AWS limit)
        // Using environment ID for uniqueness: qa-nlb-01-67wz6v9zc = 20 characters
        const nlb = new elbv2.NetworkLoadBalancer(this, 'QaBackendNlb', {
            loadBalancerName: `qa-nlb-01-67wz6v9zc`,
            vpc,
            vpcSubnets: {
                subnets: privateSubnets,
            },
            internetFacing: false,
            ipAddressType: elbv2.IpAddressType.IPV4,
        });

        // Add tags
        cdk.Tags.of(vpc).add('Name', 'garnet-qa-vpc');
        cdk.Tags.of(publicSubnet).add('Name', 'garnet-qa-vpc-public-subnet-01');
        cdk.Tags.of(publicSubnet).add('env', 'qa');
        cdk.Tags.of(jumpServer).add('Name', 'qa-rds-jump-server');
        cdk.Tags.of(jumpServerSg).add('Name', 'garnet-qa-rds-jump-server-sg');

        // Export stack outputs
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'The ID of the QA VPC');
        StackUtils.exportStack(this, 'PublicSubnetId', publicSubnet.subnetId, 'The ID of the public subnet');
        StackUtils.exportStack(
            this,
            'JumpServerInstanceId',
            jumpServer.instanceId,
            'The ID of the jump server instance',
        );
        StackUtils.exportStack(
            this,
            'JumpServerPublicIp',
            jumpServer.instancePublicIp,
            'The public IP of the jump server',
        );
        StackUtils.exportStack(
            this,
            'JumpServerPrivateIp',
            jumpServer.instancePrivateIp,
            'The private IP of the jump server',
        );
        StackUtils.exportStack(
            this,
            'AlbDnsName',
            alb.loadBalancerDnsName,
            'The DNS name of the Application Load Balancer',
        );
        StackUtils.exportStack(
            this,
            'NlbDnsName',
            nlb.loadBalancerDnsName,
            'The DNS name of the Network Load Balancer',
        );
    }
}
