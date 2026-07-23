import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import { Construct } from 'constructs';
import { Stack as DeploymentStack, StackProps as DeploymentStackProps } from 'aws-cdk-lib';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: sagemaker-yhxcakof0
 *
 * 23f1f6eb-85c8-4517-92e4-5b03ba5d0469
 *
 * What the stack does:
 * 1. Creates a dual-VPC infrastructure for Quartz helper
 * 2. Primary VPC (172.25.0.0/16) for Quartz helper infrastructure
 * 3. Customer VPC (10.1.0.0/16) for customer workload isolation
 * 4. EC2 instance (t3.micro) with dual network interfaces spanning both VPCs
 * 5. KMS key for encrypting Secrets Manager secret
 * 6. Secrets Manager secret for Quartz Proxy Server certificate and private key
 * 7. IAM instance profile for EC2 instance permissions
 * 8. User data attaches secondary ENI from customer VPC after instance launch
 * 9. Tags linking resources to SageMaker cluster 'basaltcluste'
 *
 * Note: This is a troubleshooting scenario - configurations are intentionally preserved as-is
 */

export class Sagemaker_yhxcakof0 extends DeploymentStack {
    constructor(scope: Construct, id: string, props: DeploymentStackProps) {
        super(scope, id, props);

        // KMS Key for Secrets Manager encryption
        const kmsKey = new kms.Key(this, 'KmsKey', {
            description: 'KMS key for Secrets Manager secret encryption',
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Primary VPC (Quartz helper infrastructure)
        const primaryVpc = new ec2.Vpc(this, 'PrimaryVpc', {
            ipAddresses: ec2.IpAddresses.cidr('172.25.0.0/16'),
            maxAzs: 2,
            natGateways: 1,
            subnetConfiguration: [
                {
                    name: 'QuartzHelperSubnet',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                    cidrMask: 24,
                },
                {
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                    cidrMask: 24,
                },
            ],
        });

        // Customer VPC (customer workload isolation)
        const customerVpc = new ec2.Vpc(this, 'CustomerVpc', {
            ipAddresses: ec2.IpAddresses.cidr('10.1.0.0/16'),
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    name: 'CustomerSubnet',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                    cidrMask: 24,
                },
            ],
        });

        // Security group for Quartz helper in primary VPC
        const quartzHelperSg = new ec2.SecurityGroup(this, 'QuartzHelperSg', {
            vpc: primaryVpc,
            description: 'Security group for Quartz helper instance',
            allowAllOutbound: true,
        });

        // Allow SSH from VPC CIDR — looks correct at the SG level
        quartzHelperSg.addIngressRule(
            ec2.Peer.ipv4('172.25.0.0/16'),
            ec2.Port.tcp(22),
            'Allow SSH from VPC CIDR',
        );

        // Security group for customer VPC (no ingress)
        const customerSg = new ec2.SecurityGroup(this, 'CustomerSg', {
            vpc: customerVpc,
            description: 'No ingress security group for customer VPC',
            allowAllOutbound: true,
        });

        // IAM role for EC2 instance
        const instanceRole = new iam.Role(this, 'InstanceRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
        });

        // Grant permissions to attach network interfaces
        instanceRole.addToPolicy(
            new iam.PolicyStatement({
                actions: [
                    'ec2:CreateNetworkInterface',
                    'ec2:AttachNetworkInterface',
                    'ec2:DescribeNetworkInterfaces',
                    'ec2:DescribeInstances',
                    'ec2:ModifyNetworkInterfaceAttribute',
                    'ec2:CreateTags',
                ],
                resources: ['*'],
            }),
        );

        // Grant permissions to read the secret
        kmsKey.grantDecrypt(instanceRole);

        const instanceProfile = new iam.CfnInstanceProfile(this, 'InstanceProfile', {
            roles: [instanceRole.roleName],
        });

        // Get subnets for both VPCs
        const primarySubnet = primaryVpc.privateSubnets[0];
        const customerSubnet = customerVpc.isolatedSubnets[0];

        // NACL on private subnet that denies inbound SSH
        const privateNacl = new ec2.NetworkAcl(this, 'PrivateSubnetNacl', {
            vpc: primaryVpc,
            subnetSelection: { subnets: [primarySubnet] },
        });

        privateNacl.addEntry('DenySSHInbound', {
            ruleNumber: 50,
            cidr: ec2.AclCidr.anyIpv4(),
            traffic: ec2.AclTraffic.tcpPort(22),
            direction: ec2.TrafficDirection.INGRESS,
            ruleAction: ec2.Action.DENY,
        });

        privateNacl.addEntry('AllowAllInbound', {
            ruleNumber: 100,
            cidr: ec2.AclCidr.anyIpv4(),
            traffic: ec2.AclTraffic.allTraffic(),
            direction: ec2.TrafficDirection.INGRESS,
            ruleAction: ec2.Action.ALLOW,
        });

        privateNacl.addEntry('AllowAllOutbound', {
            ruleNumber: 100,
            cidr: ec2.AclCidr.anyIpv4(),
            traffic: ec2.AclTraffic.allTraffic(),
            direction: ec2.TrafficDirection.EGRESS,
            ruleAction: ec2.Action.ALLOW,
        });

        // AMI for EC2 instance (Amazon Linux 2023)
        const machineImage = ec2.MachineImage.latestAmazonLinux2023({
            cpuType: ec2.AmazonLinuxCpuType.X86_64,
        });

        // User data to attach secondary ENI from customer VPC
        const userData = ec2.UserData.forLinux();
        userData.addCommands(
            '#!/bin/bash',
            'yum update -y',
            'yum install -y amazon-ssm-agent aws-cli',
            'systemctl enable amazon-ssm-agent',
            'systemctl start amazon-ssm-agent',
            '',
            '# Get instance ID and region',
            'INSTANCE_ID=$(ec2-metadata --instance-id | cut -d " " -f 2)',
            `REGION="${this.region}"`,
            `CUSTOMER_SUBNET="${customerSubnet.subnetId}"`,
            `CUSTOMER_SG="${customerSg.securityGroupId}"`,
            '',
            '# Create and attach secondary ENI',
            'ENI_ID=$(aws ec2 create-network-interface \\',
            '  --subnet-id $CUSTOMER_SUBNET \\',
            '  --groups $CUSTOMER_SG \\',
            '  --region $REGION \\',
            '  --query "NetworkInterface.NetworkInterfaceId" \\',
            '  --output text)',
            '',
            '# Wait for ENI to be available',
            'sleep 5',
            '',
            '# Attach ENI to instance',
            'aws ec2 attach-network-interface \\',
            '  --network-interface-id $ENI_ID \\',
            '  --instance-id $INSTANCE_ID \\',
            '  --device-index 1 \\',
            '  --region $REGION',
            '',
            '# Tag the ENI',
            'aws ec2 create-tags \\',
            '  --resources $ENI_ID \\',
            `  --tags "Key=ClusterArn,Value=arn:aws:sagemaker:${this.region}:${this.account}:cluster/basaltcluste" \\`,
            '         "Key=InstanceGroupName,Value=quartzgroup1" \\',
            '  --region $REGION',
        );

        // Launch template with only primary network interface
        const launchTemplate = new ec2.CfnLaunchTemplate(this, 'LaunchTemplate', {
            launchTemplateData: {
                instanceType: 't3.micro',
                imageId: machineImage.getImage(this).imageId,
                iamInstanceProfile: {
                    name: instanceProfile.ref,
                },
                userData: cdk.Fn.base64(userData.render()),
                blockDeviceMappings: [
                    {
                        deviceName: '/dev/xvda',
                        ebs: {
                            volumeSize: 100,
                            volumeType: 'gp3',
                            deleteOnTermination: true,
                            encrypted: true,
                        },
                    },
                ],
                metadataOptions: {
                    httpTokens: 'required',
                    httpPutResponseHopLimit: 2,
                    httpEndpoint: 'enabled',
                },
                // Only primary network interface in launch template
                networkInterfaces: [
                    {
                        deviceIndex: 0,
                        subnetId: primarySubnet.subnetId,
                        groups: [quartzHelperSg.securityGroupId],
                        deleteOnTermination: true,
                    },
                ],
                tagSpecifications: [
                    {
                        resourceType: 'instance',
                        tags: [
                            {
                                key: 'ClusterArn',
                                value: `arn:aws:sagemaker:${this.region}:${this.account}:cluster/basaltcluste`,
                            },
                            { key: 'InstanceGroupName', value: 'quartzgroup1' },
                            { key: 'RIG-Version', value: '2' },
                            { key: 'Customer-Subnet', value: customerSubnet.subnetId },
                            { key: 'Customer-SG', value: customerSg.securityGroupId },
                        ],
                    },
                    {
                        resourceType: 'network-interface',
                        tags: [
                            {
                                key: 'ClusterArn',
                                value: `arn:aws:sagemaker:${this.region}:${this.account}:cluster/basaltcluste`,
                            },
                            { key: 'InstanceGroupName', value: 'quartzgroup1' },
                        ],
                    },
                ],
            },
        });

        // Auto Scaling Group
        const asg = new autoscaling.CfnAutoScalingGroup(this, 'AutoScalingGroup', {
            minSize: '0',
            maxSize: '1',
            desiredCapacity: '0',
            vpcZoneIdentifier: [primarySubnet.subnetId],
            launchTemplate: {
                launchTemplateId: launchTemplate.ref,
                version: launchTemplate.attrLatestVersionNumber,
            },
            autoScalingGroupName: `Quartz-Helper-ASG-basaltcluste-quartzgroup1-${this.account}-${this.region}`,
            tags: [
                {
                    key: 'ClusterArn',
                    value: `arn:aws:sagemaker:${this.region}:${this.account}:cluster/basaltcluste`,
                    propagateAtLaunch: true,
                },
                {
                    key: 'InstanceGroupName',
                    value: 'quartzgroup1',
                    propagateAtLaunch: true,
                },
                {
                    key: 'RIG-Version',
                    value: '2',
                    propagateAtLaunch: true,
                },
            ],
        });

        // Secrets Manager secret for Quartz certificate
        const quartzSecret = new secretsmanager.Secret(this, 'QuartzSecret', {
            secretName: `quartz-certificate-${this.account}-test-v2-cluster-quartzgroup1-${Date.now()}`,
            description: 'Quartz Proxy Server Certificate and private key',
            encryptionKey: kmsKey,
            generateSecretString: {
                secretStringTemplate: JSON.stringify({
                    certificate: 'PLACEHOLDER_CERTIFICATE',
                    privateKey: 'PLACEHOLDER_PRIVATE_KEY',
                }),
                generateStringKey: 'password',
            },
        });

        // Add tags to secret
        cdk.Tags.of(quartzSecret).add(
            'ClusterArn',
            `arn:aws:sagemaker:${this.region}:${this.account}:cluster/basaltcluste`,
        );
        cdk.Tags.of(quartzSecret).add('InstanceGroupName', 'quartzgroup1');

        // Grant instance role permission to read the secret
        quartzSecret.grantRead(instanceRole);

        // Outputs
        StackUtils.exportStack(this, 'PrimaryVpcId', primaryVpc.vpcId, 'Primary VPC ID for Quartz helper infrastructure');
        StackUtils.exportStack(this, 'CustomerVpcId', customerVpc.vpcId, 'Customer VPC ID for workload isolation');
        StackUtils.exportStack(
            this,
            'QuartzHelperSecurityGroupId',
            quartzHelperSg.securityGroupId,
            'Security group ID for Quartz helper',
        );
        StackUtils.exportStack(
            this,
            'CustomerSecurityGroupId',
            customerSg.securityGroupId,
            'Security group ID for customer VPC',
        );
        StackUtils.exportStack(this, 'InstanceRoleArn', instanceRole.roleArn, 'IAM role ARN for EC2 instance');
        StackUtils.exportStack(this, 'InstanceProfileName', instanceProfile.ref, 'IAM instance profile name');
        StackUtils.exportStack(this, 'LaunchTemplateId', launchTemplate.ref, 'Launch template ID');
        StackUtils.exportStack(this, 'AutoScalingGroupName', asg.ref, 'Auto Scaling Group name');
        StackUtils.exportStack(
            this,
            'QuartzSecretArn',
            quartzSecret.secretArn,
            'Secrets Manager secret ARN for Quartz certificate',
        );
        StackUtils.exportStack(this, 'QuartzSecretName', quartzSecret.secretName, 'Secrets Manager secret name');
        StackUtils.exportStack(this, 'KmsKeyId', kmsKey.keyId, 'KMS key ID for secret encryption');
        StackUtils.exportStack(this, 'PrimarySubnetId', primarySubnet.subnetId, 'Primary subnet ID');
        StackUtils.exportStack(this, 'CustomerSubnetId', customerSubnet.subnetId, 'Customer subnet ID');
        StackUtils.exportStack(
            this,
            'ClusterArn',
            `arn:aws:sagemaker:${this.region}:${this.account}:cluster/basaltcluste`,
            'SageMaker cluster ARN reference',
        );

        // Export NAT Gateway ID from primary VPC public subnet
        const natGatewayId = primaryVpc.publicSubnets[0].node.findChild('NATGateway') as ec2.CfnNatGateway;
        StackUtils.exportStack(this, 'NatGatewayId', natGatewayId.ref, 'NAT Gateway ID for primary VPC');
        StackUtils.exportStack(this, 'PrivateSubnetNaclId', privateNacl.networkAclId, 'Network ACL ID for private subnet');
    }
}
