import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: ssm_document_association
 *
 * What the stack does:
 * Converted from aws-cdk-examples/typescript/ssm-document-association.
 * Creates an EC2 instance managed by SSM with a custom SSM document and association
 * that periodically creates timestamped files.
 *
 * Resources created:
 * 1. VPC (1 AZ, no NAT, private subnet with SSM endpoints)
 * 2. IAM Role for EC2 with AmazonSSMManagedInstanceCore
 * 3. EC2 Instance (t3.nano, Amazon Linux 2023) tagged Environment=Development
 * 4. SSM Document (Command type) with shell script
 * 5. SSM Association targeting tag Environment=Development on a 30-minute schedule
 */

export class SsmDocumentAssociation extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // VPC: 1 AZ, no NAT, private subnet with SSM endpoints
        const vpc = new ec2.Vpc(this, 'SsmVpc', {
            vpcName: `SsmDocAssocVpc-${this.account}-${this.region}`,
            maxAzs: 1,
            natGateways: 0,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                },
            ],
        });
        vpc.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        vpc.addInterfaceEndpoint('SsmEndpoint', {
            service: ec2.InterfaceVpcEndpointAwsService.SSM,
        });
        vpc.addInterfaceEndpoint('SsmMessagesEndpoint', {
            service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
        });
        vpc.addInterfaceEndpoint('Ec2MessagesEndpoint', {
            service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
        });

        // IAM Role for EC2 with SSM managed policy
        const role = new iam.Role(this, 'SsmInstanceRole', {
            roleName: `SsmDocAssocRole-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
            ],
        });
        role.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // EC2 Instance
        const instance = new ec2.Instance(this, 'SsmManagedInstance', {
            vpc,
            role,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.NANO),
            machineImage: ec2.MachineImage.latestAmazonLinux2023(),
            instanceName: `SsmDocAssocInstance-${this.account}-${this.region}`,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            requireImdsv2: true,
        });
        instance.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Tag instance with Environment=Development
        cdk.Tags.of(instance).add('Environment', 'Development');

        // SSM Document (Command type) with shell script
        const ssmDocument = new ssm.CfnDocument(this, 'TimestampDocument', {
            name: `WriteTimeToFile-${this.account}-${this.region}`,
            documentType: 'Command',
            content: {
                schemaVersion: '2.2',
                description: 'Write current timestamp to a new file',
                parameters: {
                    DirectoryPath: {
                        type: 'String',
                        description: 'Directory where the time files will be written',
                        default: '/tmp/time_logs',
                    },
                },
                mainSteps: [
                    {
                        action: 'aws:runShellScript',
                        name: 'writeTimeToNewFile',
                        inputs: {
                            runCommand: [
                                'mkdir -p {{DirectoryPath}}',
                                'TIMESTAMP=$(date +"%Y%m%d_%H%M%S")',
                                'FILENAME="time_$TIMESTAMP.txt"',
                                'FILEPATH="{{DirectoryPath}}/$FILENAME"',
                                'echo "Creating new time file: $FILEPATH"',
                                'date > $FILEPATH',
                                'echo "Current time written to $FILEPATH: $(cat $FILEPATH)"',
                                'echo "Total files in directory: $(ls -1 {{DirectoryPath}} | wc -l)"',
                                'echo "Operation completed on $(hostname)"',
                            ],
                        },
                    },
                ],
            },
        });

        // SSM Association targeting tag Environment=Development
        const association = new ssm.CfnAssociation(this, 'TimestampAssociation', {
            name: ssmDocument.name!,
            associationName: `TimestampAssoc-${this.account}-${this.region}`,
            scheduleExpression: 'rate(30 minutes)',
            targets: [
                {
                    key: 'tag:Environment',
                    values: ['Development'],
                },
            ],
            parameters: {
                'DirectoryPath': ['/opt/aws/time_records'],
            },
        });

        // Ensure association is created after the document
        association.addDependency(ssmDocument);

        // Stack Exports
        StackUtils.exportStack(
            this,
            'DocumentName',
            ssmDocument.name!,
            'Name of the SSM document',
        );

        StackUtils.exportStack(
            this,
            'AssociationId',
            association.attrAssociationId,
            'ID of the SSM association',
        );

        StackUtils.exportStack(
            this,
            'InstanceId',
            instance.instanceId,
            'ID of the EC2 instance managed by SSM',
        );

        StackUtils.exportStack(
            this,
            'InstanceType',
            't3.nano',
            'Instance type of the EC2 instance',
        );

        StackUtils.exportStack(
            this,
            'ScheduleExpression',
            'rate(30 minutes)',
            'Schedule expression for the SSM association',
        );

        StackUtils.exportStack(
            this,
            'TargetTagKey',
            'Environment',
            'Tag key used to target instances for the SSM association',
        );

        StackUtils.exportStack(
            this,
            'TargetTagValue',
            'Development',
            'Tag value used to target instances for the SSM association',
        );
    }
}
