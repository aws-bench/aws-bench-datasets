import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: ec2_oevoe3i3i
 * What the stack does:
 * 1. Creates VPC
 * 2. Creates 2 security groups
 * 3. Creates restrictive NACL for second subnet
 * 4. Creates 2 ENIs
 * 5. CloudWatch Log Groups for flow logs
 * 6. IAM Role for VPC Flow Logs
 * 7. 2 VPC Flow Logs
 * 8. Creates EC2 instances to generate traffic
 */

export class ec2_oevoe3i3i extends cdk.Stack {

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);


        // Create VPC
        const vpc = new ec2.Vpc(this, 'Vpc', {
            maxAzs: 2,
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

        // Security Group 1 - Allows traffic (for accepted ENI)
        const allowedSg = new ec2.SecurityGroup(this, 'AllowedSG', {
            vpc,
            allowAllOutbound: true,
        });
        allowedSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP');

        // Security Group 2 - Blocks traffic (for rejected ENI)
        const blockedSg = new ec2.SecurityGroup(this, 'BlockedSG', {
            vpc,
            allowAllOutbound: false,
        });

        // Create restrictive NACL for second subnet
        const restrictiveNacl = new ec2.NetworkAcl(this, 'RestrictiveNACL', {
            vpc,
            subnetSelection: { subnets: [vpc.privateSubnets[1]] },
        });

        // Block all traffic in restrictive NACL
        restrictiveNacl.addEntry('DenyAllIngress', {
            ruleNumber: 100,
            traffic: ec2.AclTraffic.allTraffic(),
            direction: ec2.TrafficDirection.INGRESS,
            ruleAction: ec2.Action.DENY,
            cidr: ec2.AclCidr.anyIpv4(),
        });

        // ENI 1 - Will accept traffic
        const eni1 = new ec2.CfnNetworkInterface(this, 'AcceptedENI', {
            subnetId: vpc.privateSubnets[0].subnetId,
            groupSet: [allowedSg.securityGroupId],
            description: 'ENI that accepts traffic',
        });

        // ENI 2 - Will reject traffic
        const eni2 = new ec2.CfnNetworkInterface(this, 'RejectedENI', {
            subnetId: vpc.privateSubnets[1].subnetId,
            groupSet: [blockedSg.securityGroupId],
            description: 'ENI that rejects traffic',
        });

        // CloudWatch Log Groups for flow logs
        const logGroup1 = new logs.LogGroup(this, 'FlowLogGroup1', {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const logGroup2 = new logs.LogGroup(this, 'FlowLogGroup2', {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // IAM Role for VPC Flow Logs
        const flowLogRole = new iam.Role(this, 'FlowLogRole', {
            assumedBy: new iam.ServicePrincipal('vpc-flow-logs.amazonaws.com'),
            inlinePolicies: {
                FlowLogPolicy: new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            actions: [
                                'logs:CreateLogGroup',
                                'logs:CreateLogStream',
                                'logs:PutLogEvents',
                                'logs:DescribeLogGroups',
                                'logs:DescribeLogStreams',
                            ],
                            resources: ['*'],
                        }),
                    ],
                }),
            },
        });

        // VPC Flow Log 1 - For accepted ENI
        new ec2.CfnFlowLog(this, 'FlowLog1', {
            resourceType: 'NetworkInterface',
            resourceId: eni1.attrId,
            trafficType: 'ALL',
            logDestinationType: 'cloud-watch-logs',
            logGroupName: logGroup1.logGroupName,
            deliverLogsPermissionArn: flowLogRole.roleArn,
            tags: [{ key: 'Name', value: 'AcceptedENI-FlowLog' }],
        });

        // VPC Flow Log 2 - For rejected ENI
        new ec2.CfnFlowLog(this, 'FlowLog2', {
            resourceType: 'NetworkInterface',
            resourceId: eni2.attrId,
            trafficType: 'ALL',
            logDestinationType: 'cloud-watch-logs',
            logGroupName: logGroup2.logGroupName,
            deliverLogsPermissionArn: flowLogRole.roleArn,
            tags: [{ key: 'Name', value: 'RejectedENI-FlowLog' }],
        });

        // Create EC2 instances to generate traffic
        const instance1 = new ec2.Instance(this, 'TestInstance1', {
            vpc,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: ec2.MachineImage.latestAmazonLinux2023(),
            vpcSubnets: { subnets: [vpc.privateSubnets[0]] },
            securityGroup: allowedSg,
            userData: ec2.UserData.forLinux(),
            requireImdsv2: true, // Enable IMDSv2
        });

        const instance2 = new ec2.Instance(this, 'TestInstance2', {
            vpc,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: ec2.MachineImage.latestAmazonLinux2023(),
            vpcSubnets: { subnets: [vpc.privateSubnets[1]] },
            securityGroup: blockedSg,
            userData: ec2.UserData.forLinux(),
            requireImdsv2: true, // Enable IMDSv2
        });

        // Add user data to generate network traffic
        instance1.userData.addCommands(
            'yum update -y',
            'yum install -y httpd',
            'systemctl start httpd',
            'systemctl enable httpd',
            'echo "<h1>Test Server 1</h1>" > /var/www/html/index.html',
            // Generate some outbound traffic
            'while true; do curl -s http://httpbin.org/ip > /dev/null 2>&1; sleep 30; done &',
        );

        instance2.userData.addCommands(
            'yum update -y',
            // Try to generate traffic that will be blocked
            'while true; do curl -s --connect-timeout 5 http://httpbin.org/ip > /dev/null 2>&1; sleep 30; done &',
        );

        // Outputs
        StackUtils.exportStack(this, 'AcceptedENIId', eni1.attrId, 'ENI ID');
        StackUtils.exportStack(this, 'RejectedENIId', eni2.attrId, 'ENI ID');
        StackUtils.exportStack(this, 'FlowLogGroup1Name', logGroup1.logGroupName, 'VPC Flow log group');
        StackUtils.exportStack(this, 'FlowLogGroup2Name', logGroup2.logGroupName, 'VPC Flow log group');
        StackUtils.exportStack(this, 'SecurityGroup1', allowedSg.securityGroupId, 'Security group ID');
        StackUtils.exportStack(this, 'SecurityGroup2', blockedSg.securityGroupId, 'Security group ID');
    }
}
