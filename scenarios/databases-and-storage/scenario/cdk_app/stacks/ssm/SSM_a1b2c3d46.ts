import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { RemovalPolicy } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import { StackUtils } from '../../lib/shared';

/*
* Stack ID: ssm-a1b2c3d4

* What the stack does:
1. The stack creates a VPC with two availability zone.
2. The stack creates an IAM role for SSM.
3. The stack creates one SSM node that runs Amazon Linux 2023 with SSM agent version 3.3.1230.0.
4. The stack creates two SSM node that runs Ubuntu 22.04.
5. The stack creates one SSM node that runs Windows Server 2022.
6. The stack creates one SSM node that runs Windows Server 2016.
7. The stack creates one SSM node that runs SLES 16.
*/

export class SSM_a1b2c3d46 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const number_of_managed_nodes = '6';
        const number_of_windows_server_2022_managed_nodes = '1';
        const number_of_linux_managed_nodes = '1';
        const number_of_linux2023_managed_nodes = '1';
        const number_of_sles_node = '1';
        const ssmAgentVersion = '3.3.3050.0-1';

        // Create VPC
        const vpc = new ec2.Vpc(this, 'VPC', {
            maxAzs: 2,
            natGateways: 1,
        });

        // Apply removal policy to VPC
        vpc.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // Create IAM role for SSM
        const role = new iam.Role(this, 'SSMRole', {
            roleName: `role1-ssm-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
        });

        // Apply removal policy to IAM role
        role.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // Create first SSM node running Amazon Linux 2023
        const node1 = new ec2.Instance(this, 'SSMNode1', {
            vpc,
            role,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: new ec2.AmazonLinuxImage({
                generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
            }),
            instanceName: `SSMNode1-${this.account}-${this.region}`,
            userData: ec2.UserData.forLinux(),
            requireImdsv2: true,
        });

        // Add user data to install specific SSM agent version
        node1.userData.addCommands(
            'echo "===== STARTING USER DATA SCRIPT ====="',
            'echo "Removing SSM agent"',
            'sudo yum remove -y amazon-ssm-agent',
            `sudo yum install -y https://s3.amazonaws.com/ec2-downloads-windows/SSMAgent/${ssmAgentVersion}/linux_amd64/amazon-ssm-agent.rpm`,
            'sudo systemctl restart amazon-ssm-agent',
            'echo "Verifying installed SSM Agent version..."',
            'amazon-ssm-agent --version',
            'echo "$(which amazon-ssm-agent)"',
            'echo "===== USER DATA SCRIPT COMPLETED ====="',
        );

        // Apply removal policy to first node
        node1.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // Create first ubuntu node with version 22.04
        const ubuntuNode1 = new ec2.Instance(this, 'UbuntuSSMNode1', {
            vpc,
            role,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: ec2.MachineImage.fromSsmParameter(
                '/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id',
            ),
            instanceName: `UbuntuNode-${this.account}-${this.region}`,
            requireImdsv2: true,
        });

        // Apply removal policy to first ubuntu node
        ubuntuNode1.applyRemovalPolicy(RemovalPolicy.DESTROY);
        // Create second ubuntu node with version 22.04
        const ubuntuNode2 = new ec2.Instance(this, 'UbuntuSSMNode2', {
            vpc,
            role,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: ec2.MachineImage.fromSsmParameter(
                '/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id',
            ),
            instanceName: `UbuntuNode2-${this.account}-${this.region}`,
            requireImdsv2: true,
        });

        // Apply removal policy to ubuntu node
        ubuntuNode2.applyRemovalPolicy(RemovalPolicy.DESTROY);
        // Create windows node with 2022 server
        const windowsNode1 = new ec2.Instance(this, 'WindowsSSMNode1', {
            vpc,
            role,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: new ec2.WindowsImage(ec2.WindowsVersion.WINDOWS_SERVER_2022_ENGLISH_FULL_BASE),
            instanceName: `WindowsNode1-${this.account}-${this.region}`,
            requireImdsv2: true,
        });
        windowsNode1.applyRemovalPolicy(RemovalPolicy.DESTROY);
        // Create windows node with 2016 server
        const windowsNode2 = new ec2.Instance(this, 'WindowsSSMNode2', {
            vpc,
            role,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: new ec2.WindowsImage(ec2.WindowsVersion.WINDOWS_SERVER_2016_ENGLISH_FULL_BASE),
            instanceName: `WindowsNode2-${this.account}-${this.region}`,
            requireImdsv2: true,
        });
        windowsNode2.applyRemovalPolicy(RemovalPolicy.DESTROY);
        // Create SLES node
        const slesNode = new ec2.Instance(this, 'SLESNode', {
            vpc,
            role,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: ec2.MachineImage.lookup({
                name: 'suse-sles-16-0-*',
                owners: ['amazon'],
                filters: {
                    architecture: ['x86_64'],
                },
            }),
            instanceName: `SLESNode-${this.account}-${this.region}`,
            requireImdsv2: true,
        });
        // for SLES, we need to start ssm-agent for it to be managed by ssm
        slesNode.userData.addCommands(
            'echo "===== STARTING USER DATA SCRIPT ====="',
            'sudo systemctl restart amazon-ssm-agent',
            'sudo systemctl status amazon-ssm-agent',
            'echo "===== USER DATA SCRIPT COMPLETED ====="',
        );

        // Apply removal policy to SLES node
        slesNode.applyRemovalPolicy(RemovalPolicy.DESTROY);
        const instances = [node1, windowsNode1, windowsNode2, ubuntuNode1, ubuntuNode2, slesNode];
        const instance_ids = instances.map((instance) => instance.instanceId).join(', ');
        StackUtils.exportStack(this, 'AllEC2InstanceIds', instance_ids);
        StackUtils.exportStack(this, 'SSMLinux2023Node', node1.instanceId, 'ID of the SSM Amazon Linux 2023 managed instance');
        StackUtils.exportStack(this, 'NumberOfManagedNodes', number_of_managed_nodes);
        StackUtils.exportStack(
            this,
            'FirstSSMWindowsNode',
            windowsNode1.instanceId,
            'ID of the Windows Server 2022 managed node',
        );
        StackUtils.exportStack(this, 'NumberOfWindows2022ManagedNodes', number_of_windows_server_2022_managed_nodes);
        StackUtils.exportStack(
            this,
            'FirstUbuntuNode',
            ubuntuNode1.instanceId,
            'ID of the ubuntu node with version 22.04',
        );
        StackUtils.exportStack(
            this,
            'SecondUbuntuNode',
            ubuntuNode2.instanceId,
            'ID of the second ubuntu node also with version 22.04',
        );
        StackUtils.exportStack(this, 'NumberOfLinuxManagedNodes', number_of_linux_managed_nodes);
        StackUtils.exportStack(this, 'NumberOfLinux2023ManagedNodes', number_of_linux2023_managed_nodes);
        StackUtils.exportStack(
            this,
            'SecondSSMWindowsNode',
            windowsNode2.instanceId,
            'ID of the Windows Server 2016 managed node',
        );
        StackUtils.exportStack(this, 'SLESSSMNode', slesNode.instanceId, 'The ID of the SLES managed nodes');
        StackUtils.exportStack(this, 'NumberOfSlesManagedNodes', number_of_sles_node);
        StackUtils.exportStack(this, 'SSMAgentVersion', ssmAgentVersion, 'Custom SSM agent version');
        StackUtils.exportStack(
            this,
            'SSMCustomVersionNode',
            node1.instanceId,
            `Instance ID where SSM agent version is ${ssmAgentVersion}`,
        );
    }
}
