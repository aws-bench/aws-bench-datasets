import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: ec2-pg4rychx0
 *
 * 7729ec21-1eff-425a-a18f-386a013ef237 
 *
 * What the stack does:
 * This stack creates a Helper EC2 instance with dual network interfaces across two VPCs.
 * The instance attempts to access a Secrets Manager secret encrypted with a custom KMS key.
 *
 * INTENTIONAL MISCONFIGURATION (for troubleshooting):
 * The IAM instance profile is missing kms:Decrypt permission for the KMS key that encrypts
 * the Secrets Manager secret. This will cause access denied errors when the instance tries
 * to retrieve the secret.
 *
 * Resources:
 * 1. Two VPCs (Helper Network and Customer Network)
 * 2. Two Subnets (one in each VPC)
 * 3. Two Security Groups (one in each VPC)
 * 4. KMS Key for Secrets Manager encryption
 * 5. Secrets Manager Secret (App Proxy Certificate)
 * 6. IAM Role and Instance Profile (with intentionally missing KMS permission)
 * 7. EC2 Instance (t3.micro with dual network interfaces)
 */

export class Ec2_pg4rychx0 extends cdk.Stack {
    private readonly accountId: string;

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        this.accountId = this.account;

        // Create VPC for Helper Network
        const helperVpc = new ec2.Vpc(this, 'HelperVPC', {
            vpcName: `helper-vpc-${this.account}-${this.region}`,
            ipAddresses: ec2.IpAddresses.cidr('172.25.0.0/16'),
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    name: 'HelperPrimary',
                    subnetType: ec2.SubnetType.PUBLIC,
                    cidrMask: 23,
                },
            ],
        });

        // Create VPC for Customer Network
        const customerVpc = new ec2.Vpc(this, 'CustomerVPC', {
            vpcName: `customer-vpc-${this.account}-${this.region}`,
            ipAddresses: ec2.IpAddresses.cidr('10.1.0.0/16'),
            maxAzs: 1,
            natGateways: 0,
            subnetConfiguration: [
                {
                    name: 'CustomerSecondary',
                    subnetType: ec2.SubnetType.PUBLIC,
                    cidrMask: 16,
                },
            ],
        });

        // Get the subnets
        const helperSubnet = helperVpc.publicSubnets[0];
        const customerSubnet = customerVpc.publicSubnets[0];

        // Create Security Group for Helper VPC
        const helperSecurityGroup = new ec2.SecurityGroup(this, 'HelperSecurityGroup', {
            vpc: helperVpc,
            securityGroupName: `Helper-SG-${this.account}-${this.region}`,
            description: 'Security group for Helper instance primary interface',
            allowAllOutbound: true,
        });

        // Create Security Group for Customer VPC
        const customerSecurityGroup = new ec2.SecurityGroup(this, 'CustomerSecurityGroup', {
            vpc: customerVpc,
            securityGroupName: `no-ingress-sg-${this.account}-${this.region}`,
            description: 'Security group with no ingress rules for customer network',
            allowAllOutbound: true,
        });

        // Create KMS Key for Secrets Manager encryption
        const kmsKey = new kms.Key(this, 'AppProxyKey', {
            description: 'App Proxy Certificate Encryption Key',
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Create IAM Role for EC2 Instance
        // intentional: Missing kms:Decrypt permission - this is the bug to troubleshoot
        const instanceRole = new iam.Role(this, 'HelperInstanceRole', {
            roleName: `HelperInstanceRole-pg4rychx0-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            description: 'IAM role for Helper instance',
        });

        // Grant Secrets Manager read access
        instanceRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
                resources: ['*'],
            }),
        );

        // intentional: NOT granting kms:Decrypt permission - this is the bug
        // The instance will be able to call Secrets Manager but will fail when
        // Secrets Manager tries to decrypt the secret using the KMS key

        // Create Instance Profile
        const instanceProfile = new iam.CfnInstanceProfile(this, 'HelperInstanceProfile', {
            instanceProfileName: `HelperInstanceRoleProfile-pg4rychx0-${this.account}-${this.region}`,
            roles: [instanceRole.roleName],
        });

        // Create Secrets Manager Secret encrypted with KMS key
        const secret = new secretsmanager.Secret(this, 'AppProxyCertificate', {
            secretName: `app-certificate-${this.account}-${this.region}`,
            description: 'App Proxy Server Certificate and private key',
            encryptionKey: kmsKey,
            generateSecretString: {
                secretStringTemplate: JSON.stringify({
                    certificate: 'placeholder-certificate-data',
                    privateKey: 'placeholder-private-key-data',
                }),
                generateStringKey: 'password',
            },
        });

        // Look up the Amazon Linux 2023 AMI
        const ami = ec2.MachineImage.latestAmazonLinux2023({
            cpuType: ec2.AmazonLinuxCpuType.X86_64,
        });

        // Create the EC2 Instance with primary network interface
        const instance = new ec2.Instance(this, 'HelperInstance', {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: ami,
            vpc: helperVpc,
            vpcSubnets: {
                subnets: [helperSubnet],
            },
            securityGroup: helperSecurityGroup,
            role: instanceRole,
            requireImdsv2: true,
            blockDevices: [
                {
                    deviceName: '/dev/xvda',
                    volume: ec2.BlockDeviceVolume.ebs(30, {
                        deleteOnTermination: true,
                        volumeType: ec2.EbsDeviceVolumeType.GP3,
                    }),
                },
            ],
        });

        // Add tags to the instance
        cdk.Tags.of(instance).add('ClusterArn', `arn:aws:sagemaker:${this.region}:${this.account}:cluster/app-cluster`);
        cdk.Tags.of(instance).add('InstanceGroupName', 'group1');
        cdk.Tags.of(instance).add('AppVersion', '2');
        cdk.Tags.of(instance).add('sagemaker', 'true');

        // Create secondary network interface in customer VPC
        const secondaryNetworkInterface = new ec2.CfnNetworkInterface(this, 'SecondaryNetworkInterface', {
            subnetId: customerSubnet.subnetId,
            groupSet: [customerSecurityGroup.securityGroupId],
            description: 'Secondary network interface in customer VPC',
        });

        // Attach secondary network interface to instance
        new ec2.CfnNetworkInterfaceAttachment(this, 'SecondaryNetworkInterfaceAttachment', {
            instanceId: instance.instanceId,
            networkInterfaceId: secondaryNetworkInterface.ref,
            deviceIndex: '1',
            deleteOnTermination: false,
        });

        // Export stack outputs
        StackUtils.exportStack(this, 'HelperVpcId', helperVpc.vpcId, 'VPC ID for Helper Network');
        StackUtils.exportStack(this, 'CustomerVpcId', customerVpc.vpcId, 'VPC ID for Customer Network');
        StackUtils.exportStack(this, 'InstanceId', instance.instanceId, 'EC2 Instance ID');
        StackUtils.exportStack(this, 'InstanceProfileArn', instanceProfile.attrArn, 'IAM Instance Profile ARN');
        StackUtils.exportStack(this, 'SecretArn', secret.secretArn, 'Secrets Manager Secret ARN');
        StackUtils.exportStack(this, 'KmsKeyId', kmsKey.keyId, 'KMS Key ID for secret encryption');
        StackUtils.exportStack(this, 'KmsKeyArn', kmsKey.keyArn, 'KMS Key ARN for secret encryption');
    }
}
