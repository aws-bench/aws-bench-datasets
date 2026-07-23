import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { RemovalPolicy } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import { StackUtils } from '../lib/shared';

const num_subnets = 1;
const num_ec2_running = 4;

/*
* Stack ID: ec2-ks84v1fh12

* What the stack does:
1. The stack creates a VPC with a public Subnet,
2. Creates a security group with allowed SSH, HTTP, HTTPs access,
3. Creates an IAM role with denied actions and InstanceProfile for an EC2 instance,
4. Creates an EC2 instance with the above configurations,
5. Creates an EC2 launch template,
7. Creates an EC2 instance from the launch template,
8. Creates a Custom Resource to create an AMI from the first EC2 instance.
9. Creates an EC2 instance using default VPC.
*/

export class EC2_ks84v1fh12 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);


        // Create Vpc
        const vpc = new ec2.Vpc(this, 'ResourcesVpc', {
            maxAzs: 1,
            subnetConfiguration: [
                {
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                    cidrMask: 24,
                },
                {
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                    cidrMask: 24,
                },
            ],
            natGateways: 0,
        });
        vpc.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // Create Security Group
        const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
            vpc,
            description: 'Allow specific inbound traffic',
            allowAllOutbound: true,
        });

        const sshPort = 22;
        const httpPort = 80;
        const httpsPort = 443;

        // Add inbound rules
        securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(sshPort), 'Allow SSH access');

        securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(httpPort), 'Allow HTTP access');

        securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(httpsPort), 'Allow HTTPS access');

        // Create Security Group
        const unusedSecurityGroup = new ec2.SecurityGroup(this, 'SecurityGroup1', {
            vpc,
            allowAllOutbound: true,
        });

        // Create IAM role for the instance
        const role = new iam.Role(this, 'EC2InstanceRole', {
            roleName: `role-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
        });

        // Add policies to the role as needed
        role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));

        const denyModifyInstanceAttribute = 'ec2:ModifyInstanceAttribute';
        const denyModifyInstanceMetadataOptions = 'ec2:ModifyInstanceMetadataOptions';
        // Add deny policies
        const denyPolicy = new iam.Policy(this, 'EC2DenyPolicy', {
            policyName: `policy-${this.account}-${this.region}`,
            statements: [
                // Deny modification of instance attributes
                new iam.PolicyStatement({
                    effect: iam.Effect.DENY,
                    actions: [denyModifyInstanceAttribute, denyModifyInstanceMetadataOptions],
                    resources: ['*'],
                }),
            ],
        });

        // Attach the deny policy to the role
        role.attachInlinePolicy(denyPolicy);

        const instanceProfile = new iam.InstanceProfile(this, 'InstanceProfile', {
            instanceProfileName: `instanceprofile-${this.account}-${this.region}`,
            role: role,
        });

        // Create EC2 Instance
        const instance = new ec2.Instance(this, 'WebServerInstance', {
            vpc,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PUBLIC,
            },
            securityGroup: securityGroup,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: new ec2.AmazonLinuxImage({
                generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
            }),
            requireImdsv2: true, // Enable IMDSv2
            instanceProfile: instanceProfile,
        });
        instance.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // Create Launch Template
        const launchTemplate = new ec2.CfnLaunchTemplate(this, 'LaunchTemplate', {
            launchTemplateData: {
                instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO).toString(),
                imageId: new ec2.AmazonLinuxImage({
                    generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
                }).getImage(this).imageId,
                securityGroupIds: [securityGroup.securityGroupId],
                blockDeviceMappings: [
                    {
                        deviceName: '/dev/xvda',
                        ebs: {
                            // 8 GB to match Amazon Linux default root size and minimize EBS Footprint
                            volumeSize: 8,
                            volumeType: 'gp3',
                        },
                    },
                ],
                metadataOptions: {
                    httpTokens: 'required',
                },
            },
            launchTemplateName: `lt-${this.account}-${this.region}`,
        });

        // Create EC2 Instance from Launch Template
        const instance1 = new ec2.CfnInstance(this, 'LaunchTemplateInstance', {
            launchTemplate: {
                launchTemplateId: launchTemplate.ref,
                version: '1',
            } as ec2.CfnInstance.LaunchTemplateSpecificationProperty,
            subnetId: vpc.publicSubnets[0].subnetId,
        });
        instance1.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // Add dependency to ensure launch template is created first
        instance1.addDependency(launchTemplate);

        const amiName = `ami-${this.account}-${this.region}`;

        // Custom resource to create the AMI
        const createAmi = new cr.AwsCustomResource(this, 'CreateAmi', {
            onCreate: {
                service: 'EC2',
                action: 'createImage',
                parameters: {
                    InstanceId: instance.instanceId,
                    Name: amiName,
                    Description: 'AMI created from existing EC2 instance using CDK',
                },
                physicalResourceId: cr.PhysicalResourceId.fromResponse('ImageId'),
            },
            onDelete: {
                service: 'EC2',
                action: 'deregisterImage',
                parameters: {
                    ImageId: new cr.PhysicalResourceIdReference(),
                },
            },
            policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
                resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
            }),
        });

        // Look up the default VPC
        const defaultVpc = ec2.Vpc.fromLookup(this, 'DefaultVPC', {
            isDefault: true,
        });

        // Create the EC2 instance
        const defaultVpcInstance = new ec2.Instance(this, 'MyEC2Instance', {
            vpc: defaultVpc,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PUBLIC, // Choose public subnet
            },
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: new ec2.AmazonLinuxImage({
                generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
            }),
            requireImdsv2: true, // Enable IMDSv2
        });
        defaultVpcInstance.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // Distractor: instance in a PRIVATE subnet (should NOT appear in
        // find-ec-instances-in-public-subnets results)
        const privateInstance = new ec2.Instance(this, 'PrivateInstance', {
            vpc,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            },
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: new ec2.AmazonLinuxImage({
                generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
            }),
            requireImdsv2: true,
        });
        privateInstance.applyRemovalPolicy(RemovalPolicy.DESTROY);

        StackUtils.exportStack(this, 'PrivateInstanceId', privateInstance.instanceId);
        StackUtils.exportStack(this, 'PrivateInstancePrivateIp', privateInstance.instancePrivateIp);
        StackUtils.exportStack(this, 'RoleName', role.roleName);
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'The ID of the VPC');
        StackUtils.exportStack(this, 'RestrictedActionModifyInstanceAttribute', denyModifyInstanceAttribute);
        StackUtils.exportStack(
            this,
            'RestrictedActionModifyInstanceMetadataOptions',
            denyModifyInstanceMetadataOptions,
        );
        StackUtils.exportStack(this, 'SecurityGroupId', securityGroup.securityGroupId);
        StackUtils.exportStack(this, 'UnusedSecurityGroupId', unusedSecurityGroup.securityGroupId);
        StackUtils.exportStack(this, 'PublicSubnetId', vpc.publicSubnets[0].subnetId);
        StackUtils.exportStack(this, 'InstanceProfileName', instanceProfile.instanceProfileName);
        StackUtils.exportStack(this, 'AMIName', amiName);
        StackUtils.exportStack(this, 'InstanceId', instance.instanceId, 'The ID of the EC2 instance');
        StackUtils.exportStack(this, 'LaunchTemplateInstanceId', instance1.ref, 'The ID of the EC2 instance');
        StackUtils.exportStack(this, 'NUMEC2Running', num_ec2_running.toString(), 'The number of EC2 instances');
        StackUtils.exportStack(this, 'NUMSubnets', num_subnets.toString());
        StackUtils.exportStack(this, 'OpenSSHPort', sshPort.toString(), 'SSH access port');
        StackUtils.exportStack(this, 'OpenHTTPPort', httpPort.toString(), 'HTTP access port');
        StackUtils.exportStack(this, 'OpenHTTPsPort', httpsPort.toString(), 'HTTPS access port');
        StackUtils.exportStack(this, 'StackName', this.stackName, 'Name of the Stack');
        StackUtils.exportStack(this, 'StackId', this.stackId, 'Name of the Stack');
        StackUtils.exportStack(this, 'PrivateIPOfInstanceWithoutLaunchTemplate', instance.instancePrivateIp);
        StackUtils.exportStack(this, 'PrivateIPOfInstanceWithLaunchTemplate', instance1.attrPrivateIp);
        StackUtils.exportStack(this, 'DefaultVpcId', defaultVpc.vpcId, 'The ID of the VPC');
        StackUtils.exportStack(this, 'DefaultPublicSubnetId1', defaultVpc.publicSubnets[0].subnetId);
        StackUtils.exportStack(this, 'DefaultPublicSubnetId2', defaultVpc.publicSubnets[1].subnetId);
        StackUtils.exportStack(this, 'DefaultVPCInstanceId', defaultVpcInstance.instanceId);
        StackUtils.exportStack(
            this,
            'PrivateIPOfInstanceWithDefaultVpc',
            defaultVpcInstance.instancePrivateIp,
            'The Private IP address of the Instance created with LaunchTemplate',
        );
    }
}
