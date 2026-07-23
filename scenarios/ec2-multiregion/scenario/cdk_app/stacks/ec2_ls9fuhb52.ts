import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { RemovalPolicy } from 'aws-cdk-lib';
import { StackUtils } from '../lib/shared';

const num_ec2_running = 1;
// num of subnets - AZs - updating this requires updating exports
const num_subnets = 1;

/*
* Stack ID: ec2-ls9fuhb522

* What the stack does:
1. Creates a VPC with 1 public subnet,
2. Creates an EC2 instance with a public IP address.
*/

export class EC2_ls9fuhb522 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);


        // Create Vpc
        const vpc = new ec2.Vpc(this, 'ResourcesVpc', {
            maxAzs: num_subnets,
            subnetConfiguration: [
                {
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                    cidrMask: 24,
                },
            ],
            natGateways: 0,
        });
        vpc.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // Create EC2 Instance
        const instance = new ec2.Instance(this, 'WebServerInstance', {
            vpc,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PUBLIC,
            },
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: new ec2.AmazonLinuxImage({
                generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
            }),
            requireImdsv2: true, // Enable IMDSv2
        });
        instance.applyRemovalPolicy(RemovalPolicy.DESTROY);

        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'The ID of the VPC');
        StackUtils.exportStack(this, 'InstanceId', instance.instanceId, 'The ID of the EC2 instance');
        StackUtils.exportStack(
            this,
            'PublicSubnetId',
            vpc.publicSubnets[0].subnetId,
            'The ID of the VPCs Public Subnet',
        );
        StackUtils.exportStack(this, 'NUMEC2Running', num_ec2_running.toString(), 'The number of EC2 instances');
        StackUtils.exportStack(
            this,
            'PrivateIPOfInstance',
            instance.instancePrivateIp,
            'The Private IP address of the Instance created without LaunchTemplate',
        );
        StackUtils.exportStack(this, 'StackId', this.stackId, 'Name of the Stack');
    }
}
