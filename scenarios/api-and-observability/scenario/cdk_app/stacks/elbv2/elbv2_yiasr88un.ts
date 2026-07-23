import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: elbv2-yiasr88un
 *
 * 33dde364-93e6-4cfb-9151-2a4be1b82967
 *
 * What the stack does:
 * 1. Creates a VPC with subnets for ECS and ELB resources
 * 2. Creates an ECS cluster for the web service
 * 3. Creates a Network Load Balancer
 * 4. Creates target groups for the web and management services
 * 5. Creates a security group for the ECS service
 */

export class Elbv2_yiasr88un extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // Create VPC
        const vpc = new ec2.Vpc(this, 'QuartzVpc', {
            vpcName: `quartz-vpc-${this.account}-${this.region}`,
            ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
                {
                    cidrMask: 24,
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                },
            ],
        });

        // Create security group for ECS service
        const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
            vpc,
            securityGroupName: `quartz-ecs-sg-${this.account}-${this.region}`,
            description: 'Security group for QuartzWebService ECS tasks',
            allowAllOutbound: true,
        });

        // Allow inbound traffic on port 8080
        securityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(8080),
            'Allow HTTP traffic on port 8080',
        );

        // Allow inbound traffic on port 9090
        securityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(9090),
            'Allow management API traffic on port 9090',
        );

        // Create ECS Cluster
        const cluster = new ecs.Cluster(this, 'QuartzWebServiceCluster', {
            clusterName: `QuartzWebServiceCluster-${this.account}-${this.region}`,
            vpc,
        });

        // Create Network Load Balancer
        const nlb = new elbv2.NetworkLoadBalancer(this, 'NetworkLoadBalancer', {
            loadBalancerName: `Quartz-Netwo-${this.account}`.substring(0, 32),
            vpc,
            internetFacing: false,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            },
        });

        // Target group for the web service
        const targetGroup = new elbv2.NetworkTargetGroup(this, 'TargetGroup', {
            targetGroupName: `Quartz-Targe-${this.account}`.substring(0, 32),
            vpc,
            port: 8080,
            protocol: elbv2.Protocol.TCP,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                enabled: true,
                protocol: elbv2.Protocol.HTTP,
                port: 'traffic-port',
                path: '/ping',
                interval: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(5),
                healthyThresholdCount: 5,
                unhealthyThresholdCount: 2,
            },
            deregistrationDelay: cdk.Duration.seconds(300),
        });

        // Target group for the management API
        const mgmtTargetGroup = new elbv2.NetworkTargetGroup(this, 'MgmtTargetGroup', {
            targetGroupName: `Quartz-Mgmt-${this.account}`.substring(0, 32),
            vpc,
            port: 9090,
            protocol: elbv2.Protocol.TCP,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                enabled: true,
                protocol: elbv2.Protocol.HTTP,
                port: 'traffic-port',
                path: '/health',
                interval: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(5),
                healthyThresholdCount: 3,
                unhealthyThresholdCount: 2,
            },
        });

        // Listener for management API
        nlb.addListener('MgmtListener', {
            port: 9090,
            protocol: elbv2.Protocol.TCP,
            defaultTargetGroups: [mgmtTargetGroup],
        });

        // Export stack outputs
        StackUtils.exportStack(
            this,
            'ExportsOutputRefNetworkLoadBalancer',
            nlb.loadBalancerArn,
            'Network Load Balancer ARN',
        );
        StackUtils.exportStack(
            this,
            'ExportsOutputRefTargetGroup',
            targetGroup.targetGroupArn,
            'Target Group ARN',
        );
        StackUtils.exportStack(
            this,
            'ExportsOutputFnGetAttSecurityGroupGroupId',
            securityGroup.securityGroupId,
            'Security Group ID',
        );
        StackUtils.exportStack(
            this,
            'ExportsOutputRefQuartzWebServiceCluster',
            cluster.clusterName,
            'ECS Cluster Name',
        );
        StackUtils.exportStack(
            this,
            'NLBDNS',
            nlb.loadBalancerDnsName,
            'Network Load Balancer DNS Name',
        );
        StackUtils.exportStack(
            this,
            'VpcId',
            vpc.vpcId,
            'VPC ID',
        );
        StackUtils.exportStack(
            this,
            'TargetGroupName',
            targetGroup.targetGroupName,
            'Target Group Name',
        );
        StackUtils.exportStack(
            this,
            'ExportsOutputRefMgmtTargetGroup',
            mgmtTargetGroup.targetGroupArn,
            'Management Target Group ARN',
        );
    }
}
