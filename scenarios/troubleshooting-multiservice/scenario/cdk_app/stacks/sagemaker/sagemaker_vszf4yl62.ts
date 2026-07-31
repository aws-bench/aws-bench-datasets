import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: sagemaker-vszf4yl62
 *
 * 1db6a812-38ed-43a5-b2d5-734d8ab0eeb9
 *
 * What the stack does:
 * This stack creates helper infrastructure with:
 * 1. Two VPCs (helper VPC and workload VPC) with their respective subnets
 * 2. Two security groups (one for helper, one for workload)
 * 3. An EC2 launch template (small instance — failure mode is unrelated to size)
 * 4. An Auto Scaling Group using the launch template
 * 5. A Network Load Balancer with target group for health checks
 * 6. IAM instance profile for EC2 instances
 *
 * Note: This is a troubleshooting scenario - configurations are intentionally preserved as-is
 */

export class Sagemaker_vszf4yl62 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // Create Helper VPC (172.25.0.0/16)
        const helperVpc = new ec2.Vpc(this, 'HelperVpc', {
            ipAddresses: ec2.IpAddresses.cidr('172.25.0.0/16'),
            maxAzs: 1,
            natGateways: 0,
            subnetConfiguration: [
                {
                    cidrMask: 23,
                    name: 'HelperSubnet',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                },
            ],
        });

        // Create Workload VPC (10.0.0.0/16 - changed from /8 which is invalid for VPC)
        const workloadVpc = new ec2.Vpc(this, 'WorkloadVpc', {
            ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
            maxAzs: 1,
            natGateways: 0,
            subnetConfiguration: [
                {
                    cidrMask: 20,
                    name: 'WorkloadSubnet',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                },
            ],
        });

        // Get the subnets
        const helperSubnet = helperVpc.isolatedSubnets[0];
        const workloadSubnet = workloadVpc.isolatedSubnets[0];

        // Create Helper Security Group
        const helperSecurityGroup = new ec2.SecurityGroup(this, 'HelperSecurityGroup', {
            vpc: helperVpc,
            description: 'Quartz-Helper-SG for HyperPod helper instances',
            allowAllOutbound: true,
        });

        // Create Workload Security Group (no ingress rules)
        const workloadSecurityGroup = new ec2.SecurityGroup(this, 'WorkloadSecurityGroup', {
            vpc: workloadVpc,
            description: 'no-ingress-workload-sg',
            allowAllOutbound: true,
        });

        // Create IAM Role for EC2 instances
        const instanceRole = new iam.Role(this, 'QuartzInstanceRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
        });

        // Create Instance Profile with unique name for this environment
        const instanceProfile = new iam.CfnInstanceProfile(this, 'QuartzInstanceProfile', {
            roles: [instanceRole.roleName],
            instanceProfileName: `QuartzInstanceRoleProfile-vszf4yl62-${this.account}-${this.region}`,
        });

        // Create Network Load Balancer
        // Shortened name to comply with 32-char AWS limit (26 chars)
        const nlb = new elbv2.NetworkLoadBalancer(this, 'HyperPodNLB', {
            vpc: helperVpc,
            vpcSubnets: { subnets: [helperSubnet] },
            internetFacing: false,
            loadBalancerName: 'NLB-cluster1-group1',
        });

        // Create Target Group
        // Shortened name to comply with 32-char AWS limit (15 chars)
        const targetGroup = new elbv2.NetworkTargetGroup(this, 'HyperPodTargetGroup', {
            vpc: helperVpc,
            port: 44300,
            protocol: elbv2.Protocol.TCP,
            targetType: elbv2.TargetType.INSTANCE,
            targetGroupName: 'TG-cluster1',
            healthCheck: {
                enabled: true,
                protocol: elbv2.Protocol.HTTP,
                port: '4000',
                path: '/sync-health-check',
                interval: cdk.Duration.seconds(20),
                timeout: cdk.Duration.seconds(10),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 10,
            },
        });

        // Add listener to NLB
        nlb.addListener('NLBListener', {
            port: 44300,
            protocol: elbv2.Protocol.TCP,
            defaultTargetGroups: [targetGroup],
        });

        // Create Launch Template
        // Using a valid AMI for deployment - original AMI doesn't exist in target account
        const launchTemplate = new ec2.LaunchTemplate(this, 'HyperPodLaunchTemplate', {
            launchTemplateName: `Quartz-Helper-LT-cluster1-group1-${this.account}`,
            // Instance type intentionally small: instances fail health checks due to a
            // missing security group inbound rule (the bug being tested), so instance
            // class is irrelevant. Keeping small to stay under L-1216C47A auto-approval
            // threshold.
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: ec2.MachineImage.latestAmazonLinux2023(),
            securityGroup: helperSecurityGroup,
            role: instanceRole,
            requireImdsv2: true,
            userData: ec2.UserData.custom('#!/bin/bash\n# User data not captured in trace - stub only'),
        });

        // Add tags to launch template
        cdk.Tags.of(launchTemplate).add('Quartz-Version', '2');
        cdk.Tags.of(launchTemplate).add(
            'ClusterArn',
            `arn:aws:sagemaker:${this.region}:${this.account}:cluster/cluster1`,
        );
        cdk.Tags.of(launchTemplate).add('InstanceGroupName', 'group1');
        // Use CDK references for deployment, will be replaced with hardcoded values in setup script
        cdk.Tags.of(launchTemplate).add('Workload-Subnet', workloadSubnet.subnetId);
        cdk.Tags.of(launchTemplate).add('Workload-SG', workloadSecurityGroup.securityGroupId);
        cdk.Tags.of(launchTemplate).add('IsHelper', 'true');

        // Create Auto Scaling Group
        const asg = new autoscaling.AutoScalingGroup(this, 'HyperPodHelperASG', {
            vpc: helperVpc,
            vpcSubnets: { subnets: [helperSubnet] },
            launchTemplate: launchTemplate,
            minCapacity: 0,
            maxCapacity: 2,
            desiredCapacity: 0,
            healthCheck: autoscaling.HealthCheck.elb({
                grace: cdk.Duration.seconds(0),
            }),
            autoScalingGroupName: `Quartz-Helper-ASG-cluster1-group1-${this.account}`,
        });

        // Attach ASG to target group
        asg.attachToNetworkTargetGroup(targetGroup);

        // Add tags to ASG
        cdk.Tags.of(asg).add('ClusterArn', `arn:aws:sagemaker:${this.region}:${this.account}:cluster/cluster1`);
        cdk.Tags.of(asg).add('InstanceGroupName', 'group1');
        cdk.Tags.of(asg).add('Quartz-Version', '2');

        // Export stack outputs
        StackUtils.exportStack(this, 'HelperVpcId', helperVpc.vpcId, 'Helper VPC ID');
        StackUtils.exportStack(this, 'WorkloadVpcId', workloadVpc.vpcId, 'Workload VPC ID');
        StackUtils.exportStack(this, 'HelperSubnetId', helperSubnet.subnetId, 'Helper Subnet ID');
        StackUtils.exportStack(this, 'WorkloadSubnetId', workloadSubnet.subnetId, 'Workload Subnet ID');
        StackUtils.exportStack(
            this,
            'HelperSecurityGroupId',
            helperSecurityGroup.securityGroupId,
            'Helper Security Group ID',
        );
        StackUtils.exportStack(
            this,
            'WorkloadSecurityGroupId',
            workloadSecurityGroup.securityGroupId,
            'Workload Security Group ID',
        );
        StackUtils.exportStack(this, 'AutoScalingGroupName', asg.autoScalingGroupName, 'Auto Scaling Group Name');
        StackUtils.exportStack(this, 'LaunchTemplateId', launchTemplate.launchTemplateId!, 'Launch Template ID');
        StackUtils.exportStack(this, 'NetworkLoadBalancerArn', nlb.loadBalancerArn, 'Network Load Balancer ARN');
        StackUtils.exportStack(this, 'TargetGroupArn', targetGroup.targetGroupArn, 'Target Group ARN');
        StackUtils.exportStack(this, 'InstanceProfileArn', instanceProfile.attrArn, 'Instance Profile ARN');
    }
}
