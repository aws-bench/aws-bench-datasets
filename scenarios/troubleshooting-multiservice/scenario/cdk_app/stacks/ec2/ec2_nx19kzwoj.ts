import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: ec2-nx19kzwoj
 *
 * 35f72cba-7375-4f83-8125-dcbe0edce17e
 * 
 * What the stack does:
 1. Creates a VPC with two subnets (helper-primary and customer)
 2. Creates two security groups (helper-primary and customer)
 3. Creates an IAM role and instance profile for EC2 instances
 4. Creates a launch template for the Auto Scaling Group
 5. Creates an Auto Scaling Group that manages EC2 instances
*/

export class EC2_nx19kzwoj extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // Create VPC
        const vpc = new ec2.Vpc(this, 'MainVPC', {
            vpcName: `main-vpc-${this.account}-${this.region}`,
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'HelperPrimary',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
                {
                    cidrMask: 24,
                    name: 'Customer',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
            ],
        });

        // Add S3 VPC Gateway Endpoint
        vpc.addGatewayEndpoint('S3Endpoint', {
            service: ec2.GatewayVpcEndpointAwsService.S3,
        });

        // Get the subnets - VPC creates them in order: [HelperPrimary-AZ1, HelperPrimary-AZ2, Customer-AZ1, Customer-AZ2]
        const helperPrimarySubnet = vpc.publicSubnets[0];
        const customerSubnet = vpc.publicSubnets[2];

        // Create Security Group for Helper instances
        const helperSecurityGroup = new ec2.SecurityGroup(this, 'HelperSecurityGroup', {
            vpc,
            securityGroupName: `Helper-SG-${this.account}-${this.region}`,
            description: 'Security group for Helper instances',
            allowAllOutbound: true,
        });

        // Create Security Group for Customer
        const customerSecurityGroup = new ec2.SecurityGroup(this, 'CustomerSecurityGroup', {
            vpc,
            securityGroupName: `Customer-SG-${this.account}-${this.region}`,
            description: 'Security group for customer resources',
            allowAllOutbound: true,
        });

        cdk.Tags.of(customerSecurityGroup).add('Purpose', 'Customer-Secondary-ENI-Security');
        cdk.Tags.of(customerSubnet).add('Purpose', 'Customer-Secondary-ENI-Attachment');

        // Create IAM Role for EC2 instances
        const instanceRole = new iam.Role(this, 'HelperInstanceRole', {
            roleName: `HelperInstanceRole-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
        });

        instanceRole.addToPolicy(new iam.PolicyStatement({
            actions: ['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue'],
            resources: ['*'],
        }));

        // Create Launch Template (construct ID changed to force new InstanceProfile logical ID)
        const launchTemplate = new ec2.LaunchTemplate(this, 'HelperLT', {
            launchTemplateName: `Helper-LT-${this.account}-${this.region}`,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: ec2.MachineImage.latestAmazonLinux2023(),
            securityGroup: helperSecurityGroup,
            role: instanceRole,
            requireImdsv2: true,
            blockDevices: [
                {
                    deviceName: '/dev/xvda',
                    volume: ec2.BlockDeviceVolume.ebs(100, {
                        deleteOnTermination: true,
                        volumeType: ec2.EbsDeviceVolumeType.GP3,
                    }),
                },
            ],
        });

        // Create Auto Scaling Group
        const asg = new autoscaling.AutoScalingGroup(this, 'HelperASG', {
            autoScalingGroupName: `Helper-ASG-${this.account}-${this.region}`,
            vpc,
            vpcSubnets: {
                subnets: [helperPrimarySubnet],
            },
            launchTemplate,
            minCapacity: 0,
            maxCapacity: 1,
            desiredCapacity: 0,
        });

        // Add tags to ASG
        const clusterArn = `arn:aws:sagemaker:${this.region}:${this.account}:cluster/app-cluster`;
        cdk.Tags.of(asg).add('ClusterArn', clusterArn);
        cdk.Tags.of(asg).add('InstanceGroupName', 'group1');
        cdk.Tags.of(asg).add('AppVersion', '2');

        // intentional: schema specifies these literal values — do not replace with CDK reference
        cdk.Tags.of(asg).add('Customer-SG', 'sg-01eeee4696a5c0ace');
        cdk.Tags.of(asg).add('Customer-Subnet', 'subnet-0ff0f7602567267d1');

        // Export stack outputs
        StackUtils.exportStack(this, 'VPCId', vpc.vpcId, 'The VPC ID');
        StackUtils.exportStack(this, 'HelperSubnetId', helperPrimarySubnet.subnetId, 'Helper Primary Subnet ID');
        StackUtils.exportStack(this, 'CustomerSubnetId', customerSubnet.subnetId, 'Customer Subnet ID');
        StackUtils.exportStack(this, 'HelperSecurityGroupId', helperSecurityGroup.securityGroupId, 'Helper Security Group ID');
        StackUtils.exportStack(this, 'CustomerSecurityGroupId', customerSecurityGroup.securityGroupId, 'Customer Security Group ID');
        StackUtils.exportStack(this, 'InstanceRoleName', instanceRole.roleName, 'Instance Role Name');
        StackUtils.exportStack(this, 'LaunchTemplateId', launchTemplate.launchTemplateId!, 'Launch Template ID');
        StackUtils.exportStack(this, 'AutoScalingGroupName', asg.autoScalingGroupName, 'Auto Scaling Group Name');
        StackUtils.exportStack(this, 'CustomerSGTagValue', 'sg-01eeee4696a5c0ace', 'SG ID used as ASG Customer-SG tag value');
        StackUtils.exportStack(this, 'CustomerSubnetTagValue', 'subnet-0ff0f7602567267d1', 'Subnet ID used as ASG Customer-Subnet tag value');
    }
}
