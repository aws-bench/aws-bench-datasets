import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: ec2-kxu4k2xpt
 *
 * 0d9e47e2-c45e-463b-af38-2b485fa32312
 * 
 * What the stack does:
 1. Creates a VPC with public subnets in eu-west-1
 2. Creates a security group for EC2
 3. Creates an IAM role and instance profile for EC2
 4. Creates an EC2 instance with deprecated Amazon Linux 2 AMI (intentionally vulnerable), and outdated SSM agent version.
 5. Simulates SSM agent management and CloudFormation stack metadata
*/

export class EC2_kxu4k2xpt extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // Create VPC with public subnet
        const vpc = new ec2.Vpc(this, 'VPC', {
            vpcName: `AppStack-VPC-${this.account}-${this.region}`,
            maxAzs: 1,
            natGateways: 0,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
            ],
        });

        // Create Security Group for EC2
        const ec2SecurityGroup = new ec2.SecurityGroup(this, 'EC2SecurityGroup', {
            vpc,
            description: 'Security group for EC2 instance',
            securityGroupName: `AppStack-EC2-SecurityGroup-${this.account}-${this.region}`,
            allowAllOutbound: true,
        });

        // Add ingress rule for SSH from Amazon network (prefix list)
        // Note: pl-01a74268 is a placeholder - actual prefix list IDs vary by region
        ec2SecurityGroup.addIngressRule(
            ec2.Peer.prefixList('pl-01a74268'),
            ec2.Port.tcp(22),
            'Allow SSH access from Amazon network (includes VPN)',
        );

        // Create IAM Role for EC2
        const ec2Role = new iam.Role(this, 'EC2Role', {
            roleName: `AppStack-EC2-Role-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            description: 'IAM role for EC2 instance with SSM access',
        });

        // Add SSM managed policy for Systems Manager access
        ec2Role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));

        // Create Instance Profile
        const instanceProfile = new iam.CfnInstanceProfile(this, 'EC2InstanceProfile', {
            instanceProfileName: `AppStack-EC2-InstanceProfile-${this.account}-${this.region}`,
            roles: [ec2Role.roleName],
        });

        // Create EC2 Instance with deprecated AMI
        // Note: Using a specific deprecated AMI ID from the schema
        const instance = new ec2.Instance(this, 'EC2Instance', {
            vpc,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PUBLIC,
            },
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            // Using Amazon Linux 2 AMI - intentionally using older version to simulate vulnerability
            // As SSM agent is built-in, its version will be outdated as well.
            // Pinned by ID so it survives AMI deprecation (name lookups fail for deprecated AMIs).
            // Source: amzn2-ami-hvm-2.0.20260105.1-x86_64-gp2 in eu-west-1
            machineImage: ec2.MachineImage.genericLinux({
                'eu-west-1': 'ami-0ce3d31bb64fda642',
            }),
            securityGroup: ec2SecurityGroup,
            role: ec2Role,
            requireImdsv2: true,
            blockDevices: [
                {
                    deviceName: '/dev/xvda',
                    volume: ec2.BlockDeviceVolume.ebs(8, {
                        volumeType: ec2.EbsDeviceVolumeType.GP2,
                        deleteOnTermination: true,
                        encrypted: false,
                    }),
                },
            ],
        });

        instance.node.addDependency(instanceProfile);

        // Add tags to EC2 instance (only non-aws: prefixed tags)
        cdk.Tags.of(instance).add('Name', 'AppStack-dev-eu-west-1/App-EC2-dev-eu-west-1');

        // Stack Outputs
        StackUtils.exportStack(this, 'VPCId', vpc.vpcId, 'The VPC ID');
        StackUtils.exportStack(this, 'EC2InstanceId', instance.instanceId, 'The EC2 Instance ID');
        StackUtils.exportStack(this, 'EC2InstancePrivateIp', instance.instancePrivateIp, 'The EC2 Instance Private IP');
        StackUtils.exportStack(
            this,
            'EC2SecurityGroupId',
            ec2SecurityGroup.securityGroupId,
            'The EC2 Security Group ID',
        );
        StackUtils.exportStack(this, 'EC2RoleName', ec2Role.roleName, 'The EC2 IAM Role Name');
        StackUtils.exportStack(
            this,
            'EC2InstanceProfileName',
            instanceProfile.instanceProfileName!,
            'The EC2 Instance Profile Name',
        );
        StackUtils.exportStack(this, 'EC2AmiId', (instance.node.defaultChild as ec2.CfnInstance).imageId!, 'The EC2 AMI ID');
        StackUtils.exportStack(this, 'EC2InstancePublicIp', instance.instancePublicIp, 'The EC2 Instance Public IP');
        StackUtils.exportStack(this, 'EC2InstancePublicDns', instance.instancePublicDnsName, 'The EC2 Instance Public DNS');
        const igws = vpc.node.children.filter(c => c instanceof ec2.CfnInternetGateway) as ec2.CfnInternetGateway[];
        if (igws.length > 0) {
            StackUtils.exportStack(this, 'InternetGatewayId', igws[0].ref, 'The Internet Gateway ID');
        }
    }
}
