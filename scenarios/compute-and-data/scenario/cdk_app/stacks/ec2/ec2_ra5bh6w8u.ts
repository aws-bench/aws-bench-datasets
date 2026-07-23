import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: ec2_ra5bh6w8u
 *
 * The stack creates the following resources:
 *
 * 1. 1 VPC with public subnet
 * 2. 1 Security Group
 * 3. 1 PowerUser IAM role
 * 4. 1 Instance profile for the role
 * 5. 1 50GB gp3 EBS volume
 *
 */

export class ec2_ra5bh6w8u extends cdk.Stack {
    private readonly accountId: string;

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        this.accountId = this.account;

        // VPC with public subnet
        const vpc = new ec2.Vpc(this, 'EC2VPC', {
            maxAzs: 1,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
            ],
        });
        vpc.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Security Group
        const securityGroup = new ec2.SecurityGroup(this, 'EC2SecurityGroup', {
            vpc,
            description: 'Security group for EC2 instance',
            allowAllOutbound: true,
        });
        securityGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // PowerUser IAM role
        const powerUserRole = new iam.Role(this, 'PowerUserRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('PowerUserAccess')],
        });
        powerUserRole.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Instance profile for the role
        const instanceProfile = new iam.CfnInstanceProfile(this, 'PowerUserInstanceProfile', {
            roles: [powerUserRole.roleName],
        });
        instanceProfile.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // 50GB gp3 EBS volume
        const ebsVolume = new ec2.Volume(this, 'EBSVolume', {
            availabilityZone: vpc.publicSubnets[0].availabilityZone,
            size: cdk.Size.gibibytes(50),
            volumeType: ec2.EbsDeviceVolumeType.GP3,
        });
        ebsVolume.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Export stack information
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId);
        StackUtils.exportStack(this, 'SubnetId', vpc.publicSubnets[0].subnetId);
        StackUtils.exportStack(this, 'SecurityGroupId', securityGroup.securityGroupId);
        StackUtils.exportStack(this, 'EBSVolumeId', ebsVolume.volumeId);
        StackUtils.exportStack(this, 'IAMRoleName', powerUserRole.roleName);
    }
}
