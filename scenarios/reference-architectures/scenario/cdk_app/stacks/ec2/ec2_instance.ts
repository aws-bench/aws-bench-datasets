import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack: Ec2Instance
 *
 * Converted from aws-cdk-examples/typescript/ec2-instance.
 * SECURITY FIX: SSH restricted to VPC CIDR instead of 0.0.0.0/0.
 *
 * Resources created:
 * 1. VPC (10.0.0.0/16, 2 AZs, no NAT gateways, public subnets only)
 * 2. SSH Security Group (TCP 22 from VPC CIDR only)
 * 3. Instance Security Group
 * 4. IAM Role with SSM, CloudWatchAgent, RetentionPolicy
 * 5. S3 Bucket for assets (DESTROY, autoDeleteObjects, BLOCK_ALL)
 * 6. EC2 Instance (t3.small, Amazon Linux 2023, CloudFormation Init, UserData)
 */

export class Ec2Instance extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // VPC: 10.0.0.0/16, 2 AZs, no NAT gateways, public subnets only
        const vpc = new ec2.Vpc(this, 'Ec2InstanceVpc', {
            ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'ServerPublic',
                    subnetType: ec2.SubnetType.PUBLIC,
                    mapPublicIpOnLaunch: true,
                },
            ],
        });

        // SSH Security Group: allow SSH from VPC CIDR only (security fix)
        const sshSecurityGroup = new ec2.SecurityGroup(this, 'Ec2SshSecurityGroup', {
            vpc,
            description: 'Security Group for SSH',
            allowAllOutbound: true,
        });
        sshSecurityGroup.addIngressRule(
            ec2.Peer.ipv4('10.0.0.0/16'),
            ec2.Port.tcp(22),
            'Allow SSH from VPC CIDR',
        );

        // Instance Security Group
        const instanceSecurityGroup = new ec2.SecurityGroup(this, 'Ec2InstanceSG', {
            vpc,
            description: 'Security group for EC2 instance',
            allowAllOutbound: true,
        });

        // S3 Bucket for assets
        const bucket = new s3.Bucket(this, 'Ec2AssetsBucket', {
            publicReadAccess: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
            autoDeleteObjects: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
        });

        // IAM Role with SSM, CloudWatchAgent, and RetentionPolicy
        const role = new iam.Role(this, 'Ec2InstanceRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            inlinePolicies: {
                ['RetentionPolicy']: new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            resources: ['*'],
                            actions: ['logs:PutRetentionPolicy'],
                        }),
                    ],
                }),
            },
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
            ],
        });

        // Grant the EC2 role access to the bucket
        bucket.grantReadWrite(role);

        // UserData with full setup: dnf update, packages, docker, s3 cp
        const userData = ec2.UserData.forLinux();
        userData.addCommands(
            'dnf update -y',
            'dnf install -y amazon-cloudwatch-agent nodejs20 python3-pip zip unzip docker',
            'sudo systemctl enable docker',
            'sudo systemctl start docker',
            'mkdir -p /home/ec2-user/sample',
            'aws s3 cp s3://' +
                bucket.bucketName +
                '/sample /home/ec2-user/sample --recursive',
        );

        // CloudWatch Agent configuration (inline)
        const cloudwatchAgentConfig = JSON.stringify({
            agent: {
                run_as_user: 'root',
            },
            logs: {
                logs_collected: {
                    files: {
                        collect_list: [
                            {
                                file_path: '/var/log/cloud-init-output.log',
                                log_group_name: '/ec2/log/ec2-example/',
                                log_stream_name: '{instance_id}-cloud-init-output',
                                retention_in_days: 7,
                            },
                            {
                                file_path: '/var/log/cloud-init.log',
                                log_group_name: '/ec2/log/ec2-example/',
                                log_stream_name: '{instance_id}-cloud-init',
                                retention_in_days: 7,
                            },
                        ],
                    },
                },
            },
        }, null, 2);

        // config.sh content (inline)
        const configShContent = '#!/bin/bash -xe\n/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/tmp/amazon-cloudwatch-agent.json\n';

        // Default SSH public key placeholder
        const sshPubKey = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDplaceholder ec2-user';

        // EC2 Instance (t3.small, Amazon Linux 2023, CloudFormation Init, SSM)
        const instance = new ec2.Instance(this, 'Ec2InstanceHost', {
            vpc,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
            machineImage: ec2.MachineImage.latestAmazonLinux2023(),
            userData,
            securityGroup: instanceSecurityGroup,
            requireImdsv2: true,
            init: ec2.CloudFormationInit.fromConfigSets({
                configSets: {
                    default: ['config'],
                },
                configs: {
                    config: new ec2.InitConfig([
                        ec2.InitFile.fromObject('/etc/config.json', {
                            STACK_ID: cdk.Stack.of(this).artifactId,
                        }),
                        ec2.InitFile.fromString(
                            '/tmp/amazon-cloudwatch-agent.json',
                            cloudwatchAgentConfig,
                        ),
                        ec2.InitFile.fromString(
                            '/etc/config.sh',
                            configShContent,
                        ),
                        ec2.InitFile.fromString(
                            '/home/ec2-user/.ssh/authorized_keys',
                            sshPubKey + '\n',
                        ),
                        ec2.InitCommand.shellCommand('chmod +x /etc/config.sh'),
                        ec2.InitCommand.shellCommand('/etc/config.sh'),
                    ]),
                },
            }),
            initOptions: {
                timeout: cdk.Duration.minutes(10),
                includeUrl: true,
                includeRole: true,
                printLog: true,
            },
            role,
        });
        instance.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Add the SSH Security Group to the EC2 instance
        instance.addSecurityGroup(sshSecurityGroup);

        // Exports
        StackUtils.exportStack(this, 'InstanceId', instance.instanceId, 'EC2 instance ID');
        StackUtils.exportStack(this, 'InstanceType', 't3.small', 'EC2 instance type');
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'VPC ID');
        StackUtils.exportStack(this, 'VpcCidr', '10.0.0.0/16', 'VPC CIDR block');
        StackUtils.exportStack(this, 'SecurityGroupId', instanceSecurityGroup.securityGroupId, 'Security group ID');
        StackUtils.exportStack(this, 'BucketName', bucket.bucketName, 'S3 bucket name for assets');
        StackUtils.exportStack(this, 'RoleName', role.roleName, 'IAM role name for EC2 instance');
        StackUtils.exportStack(
            this,
            'SsmSessionCommand',
            `aws ssm start-session --target ${instance.instanceId}`,
            'AWS CLI command to start SSM session',
        );
        StackUtils.exportStack(
            this,
            'SshCommand',
            `ssh ec2-user@${instance.instancePublicDnsName}`,
            'SSH Command to connect to the EC2 Instance',
        );
    }
}
