import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * ALB with Auto Scaling Group Stack
 *
 * Converted from aws-cdk-examples/typescript/application-load-balancer
 *
 * Creates:
 * 1. VPC (2 AZs)
 * 2. Security Groups (ALB: VPC CIDR only, Instance: ALB SG only)
 * 3. Launch Template (t4g.micro, Amazon Linux 2023 ARM)
 * 4. Auto Scaling Group with request-count scaling
 * 5. Internal Application Load Balancer with HTTP listener
 */

export class AlbAutoscaling extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const vpc = new ec2.Vpc(this, 'VPC', { maxAzs: 2 });

        // ALB SG - restrict to VPC CIDR
        const albSg = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
            vpc,
            description: 'Security group for internal ALB',
            allowAllOutbound: true,
        });
        albSg.addIngressRule(
            ec2.Peer.ipv4(vpc.vpcCidrBlock),
            ec2.Port.tcp(80),
            'Allow HTTP from VPC CIDR only',
        );

        // Instance SG - allow from ALB SG only
        const instanceSg = new ec2.SecurityGroup(this, 'InstanceSecurityGroup', {
            vpc,
            description: 'Security group for ASG instances',
            allowAllOutbound: true,
        });
        instanceSg.addIngressRule(
            albSg,
            ec2.Port.tcp(80),
            'Allow HTTP from ALB security group',
        );

        // Launch Template (replaces deprecated LaunchConfiguration)
        const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MICRO),
            machineImage: ec2.MachineImage.latestAmazonLinux2023({
                cpuType: ec2.AmazonLinuxCpuType.ARM_64,
            }),
            securityGroup: instanceSg,
            requireImdsv2: true,
        });

        // Auto Scaling Group
        const asg = new autoscaling.AutoScalingGroup(this, 'ASG', {
            vpc,
            launchTemplate,
        });

        // Internal ALB
        const lb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
            vpc,
            internetFacing: false,
            securityGroup: albSg,
        });

        const listener = lb.addListener('Listener', { port: 80 });

        const targetGroup = listener.addTargets('Target', {
            port: 80,
            targets: [asg],
        });

        asg.scaleOnRequestCount('AModestLoad', {
            targetRequestsPerMinute: 60,
        });

        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'VPC ID');
        StackUtils.exportStack(this, 'AlbDnsName', lb.loadBalancerDnsName, 'Internal ALB DNS Name');
        StackUtils.exportStack(this, 'AlbArn', lb.loadBalancerArn, 'ALB ARN');
        StackUtils.exportStack(this, 'AsgName', asg.autoScalingGroupName, 'Auto Scaling Group Name');
        StackUtils.exportStack(this, 'LaunchTemplateId', launchTemplate.launchTemplateId!, 'Launch Template ID');
        StackUtils.exportStack(this, 'TargetGroupArn', targetGroup.targetGroupArn, 'Target Group ARN');
        StackUtils.exportStack(this, 'ListenerArn', listener.listenerArn, 'Listener ARN');
    }
}
