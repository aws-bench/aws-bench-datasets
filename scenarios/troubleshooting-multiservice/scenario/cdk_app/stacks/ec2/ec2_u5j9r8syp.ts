import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: ec2-u5j9r8syp
 *
 * 9e668405-7b89-4170-ab46-829c99d47674
 *
 * Troubleshooting Mode: ENABLED - Intentionally broken configurations preserved
 *
 * What the stack does:
 * This stack creates an EC2 Auto Scaling environment with helper instances
 * that fail to launch due to an invalid KMS key state. The infrastructure includes:
 * 1. VPC with private subnet in us-west-2
 * 2. Security groups (platform and customer)
 * 3. IAM instance profile and role for EC2 instances
 * 4. KMS key in invalid state (intentionally broken)
 * 5. Launch template for helper instances (configured to use encrypted volumes with invalid KMS key)
 * 6. Auto Scaling Group
 * 7. S3 bucket for escrow
 *
 * CRITICAL: This is a troubleshooting scenario. The KMS key is intentionally in an invalid
 * state to replicate the failure condition where EC2 instances cannot launch due to
 * Client.InvalidKMSKey.InvalidState error.
 */

export class Ec2_u5j9r8syp extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const envId = 'u5j9r8syp';

        // 1. Create VPC with unique name
        const vpc = new ec2.Vpc(this, 'CustomerVpc', {
            vpcName: `app-service-vpc-${envId}-${this.account}-${this.region}`,
            maxAzs: 2,
            natGateways: 1,
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

        // Get the private subnet (first available)
        const customerSubnet = vpc.privateSubnets[0];

        // 2. Create Security Groups with unique names
        const platformSecurityGroup = new ec2.SecurityGroup(this, 'PlatformSecurityGroup', {
            vpc,
            securityGroupName: `platform-sg-${envId}-${this.account}-${this.region}`,
            description: 'Platform-managed security group for helper instances',
            allowAllOutbound: true,
        });

        const customerSecurityGroup = new ec2.SecurityGroup(this, 'CustomerSecurityGroup', {
            vpc,
            securityGroupName: `customer-sg-${envId}-${this.account}-${this.region}`,
            description: 'Customer-provided security group',
            allowAllOutbound: true,
        });

        cdk.Tags.of(customerSecurityGroup).add('Type', 'Customer-SG');

        // 3. Create IAM Role with unique name
        const instanceRole = new iam.Role(this, 'HelperInstanceRole', {
            roleName: `HelperInstanceRole-${envId}-${this.account}-${this.region}`,
            description: 'IAM role for helper EC2 instances',
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
        });

        // Add permissions for S3
        instanceRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
                resources: ['*'],
            }),
        );

        // 4. Create KMS Key in DISABLED state (intentionally broken)
        // CRITICAL: This key is intentionally disabled to replicate the failure scenario
        const kmsKey = new kms.Key(this, 'CrossAccountAmiEncryptionKey', {
            description: `cross-account-ami-encryption-key-${envId} (INTENTIONALLY DISABLED)`,
            enabled: false, // intentional: schema specifies invalid_state
            enableKeyRotation: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // 5. Create S3 Bucket with unique name
        const escrowBucket = new s3.Bucket(this, 'CustomerEscrowBucket', {
            bucketName: `app-escrow-${envId}-${this.account}-${cdk.Fn.select(0, cdk.Fn.split('-', cdk.Fn.select(2, cdk.Fn.split('/', cdk.Aws.STACK_ID))))}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        // 6. Create Launch Template with encrypted EBS volumes using invalid KMS key
        const launchTemplate = new ec2.LaunchTemplate(this, 'HelperLaunchTemplate', {
            launchTemplateName: `Helper-LT-${envId}-${this.account}-${this.region}`,
            // Instance type intentionally small: launch fails before instance creation
            // due to disabled KMS key on the encrypted root volume (the bug being tested),
            // so instance class is irrelevant. Keeping small to stay under
            // L-1216C47A auto-approval threshold.
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: ec2.MachineImage.latestAmazonLinux2023({
                cpuType: ec2.AmazonLinuxCpuType.X86_64,
            }),
            role: instanceRole,
            requireImdsv2: true,
            securityGroup: platformSecurityGroup,
            blockDevices: [
                {
                    deviceName: '/dev/xvda',
                    volume: ec2.BlockDeviceVolume.ebs(100, {
                        volumeType: ec2.EbsDeviceVolumeType.GP2,
                        encrypted: true,
                        kmsKey: kmsKey, // intentional: uses disabled KMS key - will cause launch failure
                        deleteOnTermination: true,
                    }),
                },
            ],
            userData: ec2.UserData.forLinux(),
        });

        // Add tags to launch template
        const cfnLaunchTemplate = launchTemplate.node.defaultChild as ec2.CfnLaunchTemplate;
        cfnLaunchTemplate.launchTemplateData = {
            ...cfnLaunchTemplate.launchTemplateData,
            securityGroupIds: [
                platformSecurityGroup.securityGroupId,
                customerSecurityGroup.securityGroupId,
            ],
            tagSpecifications: [
                {
                    resourceType: 'instance',
                    tags: [
                        { key: 'AppVersion', value: '2' },
                        {
                            key: 'ClusterArn',
                            value: `arn:aws:sagemaker:${this.region}:${this.account}:cluster/app-cluster-${envId}`,
                        },
                        { key: 'InstanceGroupName', value: 'group1' },
                        { key: 'Customer-Subnet', value: customerSubnet.subnetId },
                        { key: 'Customer-SG', value: customerSecurityGroup.securityGroupId },
                        { key: 'EnvironmentId', value: envId },
                    ],
                },
            ],
        };

        // 7. Create Auto Scaling Group with unique name
        const asg = new autoscaling.AutoScalingGroup(this, 'HelperAsg', {
            autoScalingGroupName: `Helper-ASG-${envId}-${this.account}-${this.region}`,
            vpc,
            vpcSubnets: { subnets: [customerSubnet] },
            launchTemplate,
            minCapacity: 0,
            maxCapacity: 1,
            desiredCapacity: 0, // Start with 0 to avoid immediate launch failures
        });

        // 8. Export stack outputs
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'VPC ID');
        StackUtils.exportStack(this, 'CustomerSubnetId', customerSubnet.subnetId, 'Customer subnet ID');
        StackUtils.exportStack(
            this,
            'PlatformSecurityGroupId',
            platformSecurityGroup.securityGroupId,
            'Platform security group ID',
        );
        StackUtils.exportStack(
            this,
            'CustomerSecurityGroupId',
            customerSecurityGroup.securityGroupId,
            'Customer security group ID',
        );
        StackUtils.exportStack(this, 'InstanceRoleArn', instanceRole.roleArn, 'IAM role ARN for EC2 instances');
        StackUtils.exportStack(this, 'InstanceRoleName', instanceRole.roleName, 'IAM role name for EC2 instances');
        StackUtils.exportStack(this, 'KmsKeyId', kmsKey.keyId, 'KMS key ID (DISABLED - intentionally broken)');
        StackUtils.exportStack(this, 'KmsKeyArn', kmsKey.keyArn, 'KMS key ARN (DISABLED - intentionally broken)');
        StackUtils.exportStack(
            this,
            'KmsKeyState',
            'DISABLED',
            'KMS key state - intentionally disabled for troubleshooting',
        );
        StackUtils.exportStack(this, 'LaunchTemplateId', launchTemplate.launchTemplateId!, 'Launch template ID');
        StackUtils.exportStack(this, 'LaunchTemplateName', `Helper-LT-${envId}-${this.account}-${this.region}`, 'Launch template name');
        StackUtils.exportStack(this, 'AutoScalingGroupName', asg.autoScalingGroupName, 'Auto Scaling Group name');
        StackUtils.exportStack(this, 'EscrowBucketName', escrowBucket.bucketName, 'Escrow bucket name');
        StackUtils.exportStack(
            this,
            'TroubleshootingNote',
            'KMS key is intentionally DISABLED - EC2 instances will fail to launch with Client.InvalidKMSKey.InvalidState',
            'Troubleshooting scenario description',
        );
        StackUtils.exportStack(
            this,
            'AccountRootArn',
            `arn:aws:iam::${this.account}:root`,
            'Account root ARN',
        );
        StackUtils.exportStack(
            this,
            'InstanceProfileName',
            `${instanceRole.roleName}-profile`,
            'IAM instance profile name',
        );
    }
}
