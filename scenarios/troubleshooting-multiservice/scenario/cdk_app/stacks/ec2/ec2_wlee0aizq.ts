import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { Stack as DeploymentStack, StackProps as DeploymentStackProps } from 'aws-cdk-lib';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: ec2-wlee0aizq
 *
 * 7fd7f9fd-df7a-46d3-89a8-3160951db4c1
 *
 * What the stack does:
 * 1. Creates a VPC with a single isolated private subnet
 * 2. Creates one EC2 instance with IMDSv2 enforced AND InstanceMetadataTags: enabled — the target instance (tags exposed via IMDS)
 * 3. Creates one decoy EC2 instance with IMDSv2 enforced and default metadata options
 * 4. Creates one decoy EC2 instance with IMDSv2 enforced and a non-default HttpPutResponseHopLimit — looks suspicious but does not expose tags
 *
 * Note: This is a troubleshooting scenario - configurations are intentionally preserved as-is
 */
export class Ec2_wlee0aizq extends DeploymentStack {
    constructor(scope: Construct, id: string, props: DeploymentStackProps) {
        super(scope, id, props);

        const vpc = new ec2.Vpc(this, 'FlintVpc', {
            vpcName: `Flint-Vpc-${this.account}-${this.region}`,
            ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
            maxAzs: 1,
            natGateways: 0,
            subnetConfiguration: [{ name: 'Private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 19 }],
        });

        const sg = new ec2.SecurityGroup(this, 'InstanceSg', { vpc, allowAllOutbound: false });

        const role = new iam.Role(this, 'InstanceRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
        });

        const baseProps = {
            vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: ec2.MachineImage.latestAmazonLinux2023(),
            securityGroup: sg,
            role,
        };

        // Target instance — IMDSv2 enforced, but InstanceMetadataTags exposes tags via IMDS
        const instance = new ec2.Instance(this, 'TestDbConnection', {
            ...baseProps,
            instanceName: `flint-dbserver-${this.account}-${this.region}`,
            requireImdsv2: true,
        });
        (instance.node.defaultChild as ec2.CfnInstance).addPropertyOverride('MetadataOptions', {
            HttpTokens: 'required',
            HttpEndpoint: 'enabled',
            HttpPutResponseHopLimit: 2,
            HttpProtocolIpv6: 'disabled',
            InstanceMetadataTags: 'enabled',
        });
        cdk.Tags.of(instance).add('Name', 'flint-dbserver');

        // Decoy instance 1 — IMDSv2 enforced with default metadata options
        const decoy1 = new ec2.Instance(this, 'AppServer1', {
            ...baseProps,
            instanceName: `app-server-1-${this.account}-${this.region}`,
            requireImdsv2: true,
        });
        cdk.Tags.of(decoy1).add('Name', 'app-server-1');

        // Decoy instance 2 — IMDSv2 enforced, non-default HttpPutResponseHopLimit (looks suspicious but does not expose tags)
        const decoy2 = new ec2.Instance(this, 'AppServer2', {
            ...baseProps,
            instanceName: `app-server-2-${this.account}-${this.region}`,
            requireImdsv2: true,
        });
        (decoy2.node.defaultChild as ec2.CfnInstance).addPropertyOverride('MetadataOptions', {
            HttpTokens: 'required',
            HttpEndpoint: 'enabled',
            HttpPutResponseHopLimit: 3,
            InstanceMetadataTags: 'disabled',
        });
        cdk.Tags.of(decoy2).add('Name', 'app-server-2');

        StackUtils.exportStack(this, 'InstanceId', instance.instanceId, 'The ID of the target EC2 instance');
        StackUtils.exportStack(this, 'OtherInstance1Id', decoy1.instanceId, 'The ID of a sibling instance');
        StackUtils.exportStack(this, 'OtherInstance2Id', decoy2.instanceId, 'The ID of a sibling instance');
    }
}
