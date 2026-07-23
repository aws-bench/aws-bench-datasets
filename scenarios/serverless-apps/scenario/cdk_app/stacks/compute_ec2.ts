import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StackUtils } from '../lib/shared';

export interface ComputeEc2StackProps extends cdk.StackProps {
    vpc: ec2.IVpc;
}

export class ComputeEc2Stack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: ComputeEc2StackProps) {
        super(scope, id, props);

        const { vpc } = props;

        // Create Launch Template
        const launchTemplate = new ec2.CfnLaunchTemplate(this, 'MyLaunchTemplate', {
            launchTemplateData: {
                instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO).toString(),
                imageId: new ec2.AmazonLinuxImage({
                    generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
                }).getImage(this).imageId,
                metadataOptions: {
                    httpTokens: 'required',
                    httpPutResponseHopLimit: 1,
                    httpEndpoint: 'enabled',
                },
            },
        });

        // Add specific instance role and permissions
        const instanceRole = new iam.Role(this, 'Ec2InstanceRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
        });

        const instanceProfile = new iam.CfnInstanceProfile(this, 'InstanceProfile', {
            roles: [instanceRole.roleName],
        });

        // Create EC2 instance with IMDSv2 and tags using launch template
        const instance = new ec2.CfnInstance(this, 'TestInstance', {
            subnetId: vpc.publicSubnets[0].subnetId,
            iamInstanceProfile: instanceProfile.ref,
            launchTemplate: {
                launchTemplateId: launchTemplate.ref,
                version: launchTemplate.attrLatestVersionNumber,
            },
        });

        instance.node.addDependency(vpc);

        // Add tags to EC2 instance
        cdk.Tags.of(instance).add('CreatedBy', 'example-user');

        // Export EC2 resources
        StackUtils.exportStack(this, 'EC2InstanceId', instance.ref);
        StackUtils.exportStack(this, 'LaunchTemplateId', launchTemplate.ref || 'none');
    }
}
