import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: elbv2-n35haewp6
 * 
 * 3d6fbb8b-6db3-4e31-917a-ad1d8492ad8f
 * 
 * What the stack does:
 1. Creates a VPC with a subnet for cluster infrastructure
 2. Creates a security group with ingress/egress rules for cluster communication
 3. Creates an IAM instance profile for EC2 instances
 4. Creates a launch template for EC2 instances with specific configuration
 5. Creates an Auto Scaling Group that uses the launch template
 6. Creates a Network Load Balancer (NLB) target group with health checks
 7. Creates an internal Network Load Balancer
 8. Creates a cluster resource
 * IMPORTANT: This is a troubleshooting environment - configurations may be intentionally misconfigured
*/

export class Elbv2_n35haewp6 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // Create VPC with specific CIDR
        const vpc = new ec2.Vpc(this, 'VPC', {
            vpcName: `vpc-appcluster-${this.account}-${this.region}`,
            ipAddresses: ec2.IpAddresses.cidr('172.25.0.0/16'),
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    cidrMask: 23,
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                },
            ],
        });

        // Get the first private subnet
        const subnet = vpc.isolatedSubnets[0];

        // Create Security Group with specific rules from schema
        const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
            vpc: vpc,
            securityGroupName: `AppCluster-SG-${this.account}-${this.region}`,
            description: `Security group for cluster instances in ${this.region}`,
            allowAllOutbound: false,
        });

        // Add self-referencing ingress rules using CfnSecurityGroupIngress to avoid circular dependency
        new ec2.CfnSecurityGroupIngress(this, 'IngressTCP988', {
            groupId: securityGroup.securityGroupId,
            ipProtocol: 'tcp',
            fromPort: 988,
            toPort: 988,
            sourceSecurityGroupId: securityGroup.securityGroupId,
            description: 'Allow TCP 988 from self',
        });

        new ec2.CfnSecurityGroupIngress(this, 'IngressAllTraffic', {
            groupId: securityGroup.securityGroupId,
            ipProtocol: '-1',
            sourceSecurityGroupId: securityGroup.securityGroupId,
            description: 'Allow all traffic from self',
        });

        new ec2.CfnSecurityGroupIngress(this, 'IngressTCP1018to1023', {
            groupId: securityGroup.securityGroupId,
            ipProtocol: 'tcp',
            fromPort: 1018,
            toPort: 1023,
            sourceSecurityGroupId: securityGroup.securityGroupId,
            description: 'Allow TCP 1018-1023 from self',
        });

        // Add self-referencing egress rules using CfnSecurityGroupEgress to avoid circular dependency
        new ec2.CfnSecurityGroupEgress(this, 'EgressTCP988', {
            groupId: securityGroup.securityGroupId,
            ipProtocol: 'tcp',
            fromPort: 988,
            toPort: 988,
            destinationSecurityGroupId: securityGroup.securityGroupId,
            description: 'Allow TCP 988 to self',
        });

        new ec2.CfnSecurityGroupEgress(this, 'EgressAllTraffic', {
            groupId: securityGroup.securityGroupId,
            ipProtocol: '-1',
            destinationSecurityGroupId: securityGroup.securityGroupId,
            description: 'Allow all traffic to self',
        });

        new ec2.CfnSecurityGroupEgress(this, 'EgressTCP1018to1023', {
            groupId: securityGroup.securityGroupId,
            ipProtocol: 'tcp',
            fromPort: 1018,
            toPort: 1023,
            destinationSecurityGroupId: securityGroup.securityGroupId,
            description: 'Allow TCP 1018-1023 to self',
        });

        // Add prefix list egress (S3 gateway endpoint)
        new ec2.CfnSecurityGroupEgress(this, 'EgressPrefixList', {
            groupId: securityGroup.securityGroupId,
            ipProtocol: '-1',
            destinationPrefixListId: 'pl-68a54001',
            description: 'Allow all traffic to S3 prefix list',
        });

        cdk.Tags.of(securityGroup).add(
            'ClusterArn',
            `arn:aws:sagemaker:${this.region}:${this.account}:cluster/appcluster`,
        );

        // Create IAM Role for EC2 instances
        const instanceRole = new iam.Role(this, 'InstanceRole', {
            roleName: `InstanceRole-n35haewp6-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
        });

        // Create Instance Profile with unique name for this environment
        const instanceProfile = new iam.CfnInstanceProfile(this, 'InstanceProfile', {
            instanceProfileName: `InstanceRoleProfile-n35haewp6-${this.account}-${this.region}`,
            roles: [instanceRole.roleName],
        });

        // Use Amazon Linux 2023 AMI (valid for this account)
        const ami = ec2.MachineImage.latestAmazonLinux2023({
            cpuType: ec2.AmazonLinuxCpuType.X86_64,
        });

        // Create Launch Template
        const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
            launchTemplateName: `launch-template-appcluster-${this.account}-${this.region}`,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: ami,
            securityGroup: securityGroup,
            requireImdsv2: true,
        });

        // Override launch template to add instance profile and metadata options
        const cfnLaunchTemplate = launchTemplate.node.defaultChild as ec2.CfnLaunchTemplate;
        cfnLaunchTemplate.addPropertyOverride('LaunchTemplateData.IamInstanceProfile', {
            Name: instanceProfile.instanceProfileName,
        });
        cfnLaunchTemplate.addPropertyOverride('LaunchTemplateData.MetadataOptions', {
            HttpTokens: 'required',
            HttpPutResponseHopLimit: 2,
            HttpEndpoint: 'enabled',
        });

        cdk.Tags.of(launchTemplate).add('AppVersion', '2');
        cdk.Tags.of(launchTemplate).add(
            'ClusterArn',
            `arn:aws:sagemaker:${this.region}:${this.account}:cluster/appcluster`,
        );
        cdk.Tags.of(launchTemplate).add('InstanceGroupName', 'group1');

        // Create Target Group
        // intentional: schema specifies this exact name - do not add account/region suffix
        const targetGroup = new elbv2.NetworkTargetGroup(this, 'TargetGroup', {
            targetGroupName: 'TG-appcluster',
            vpc: vpc,
            port: 44300,
            protocol: elbv2.Protocol.TCP,
            targetType: elbv2.TargetType.INSTANCE,
            healthCheck: {
                enabled: true,
                protocol: elbv2.Protocol.HTTP,
                port: '4000',
                path: '/health-check',
                interval: cdk.Duration.seconds(20),
                timeout: cdk.Duration.seconds(10),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 10,
            },
            deregistrationDelay: cdk.Duration.seconds(300),
        });

        // Create Network Load Balancer
        // intentional: schema specifies this exact name - do not add account/region suffix
        const nlb = new elbv2.NetworkLoadBalancer(this, 'NLB', {
            loadBalancerName: 'NLB-appcluster-group1',
            vpc: vpc,
            internetFacing: false,
            vpcSubnets: {
                subnets: [subnet],
            },
        });

        // Add listener to NLB
        nlb.addListener('Listener', {
            port: 44300,
            protocol: elbv2.Protocol.TCP,
            defaultTargetGroups: [targetGroup],
        });

        // Create Auto Scaling Group
        const asg = new autoscaling.AutoScalingGroup(this, 'ASG', {
            autoScalingGroupName: `AppCluster-ASG-appcluster-group1-${this.account}-${this.region}`,
            vpc: vpc,
            vpcSubnets: {
                subnets: [subnet],
            },
            launchTemplate: launchTemplate,
            minCapacity: 0,
            maxCapacity: 2,
            desiredCapacity: 0,
            healthCheck: autoscaling.HealthCheck.elb({
                grace: cdk.Duration.seconds(200),
            }),
        });

        // Attach ASG to target group
        asg.attachToNetworkTargetGroup(targetGroup);

        // Exports
        StackUtils.exportStack(this, 'VPCId', vpc.vpcId, 'The VPC ID');
        StackUtils.exportStack(this, 'SubnetId', subnet.subnetId, 'The Subnet ID');
        StackUtils.exportStack(this, 'SecurityGroupId', securityGroup.securityGroupId, 'The Security Group ID');
        StackUtils.exportStack(this, 'TargetGroupArn', targetGroup.targetGroupArn, 'The Target Group ARN');
        StackUtils.exportStack(this, 'TargetGroupName', targetGroup.targetGroupName, 'The Target Group Name');
        StackUtils.exportStack(this, 'NLBArn', nlb.loadBalancerArn, 'The Network Load Balancer ARN');
        StackUtils.exportStack(this, 'ASGName', asg.autoScalingGroupName, 'The Auto Scaling Group Name');
        StackUtils.exportStack(this, 'LaunchTemplateId', launchTemplate.launchTemplateId!, 'The Launch Template ID');
        StackUtils.exportStack(
            this,
            'InstanceProfileName',
            instanceProfile.instanceProfileName!,
            'The Instance Profile Name',
        );
    }
}
