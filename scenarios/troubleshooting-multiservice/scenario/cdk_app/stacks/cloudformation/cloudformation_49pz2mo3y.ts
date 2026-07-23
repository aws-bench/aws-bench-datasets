import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { Stack as DeploymentStack, StackProps as DeploymentStackProps } from 'aws-cdk-lib';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: cloudformation-49pz2mo3y
 *
 * 51e0745b-b764-48b9-96b7-8d94cc64b49b
 *
 * What the stack does:
 * 1. Creates an IAM role and inline policy for BirchService SSM operations
 * 2. Creates multiple SSM Command documents for BirchService operations
 * 3. Creates an SSM Session document for audit logging to CloudWatch
 * 4. Creates a CloudWatch log group for SSM session audit logs
 *
 * Note: Resources are only created in eu-central-1; ap-southeast-1 is intentionally empty (troubleshooting scenario)
 */

export class Cloudformation_49pz2mo3y extends DeploymentStack {

    constructor(scope: Construct, id: string, props: DeploymentStackProps) {
        super(scope, id, props);


        // Only create resources in eu-central-1
        // In ap-southeast-1, the stack should not exist (troubleshooting scenario)
        if (this.region === 'eu-central-1') {
            this.createEuCentral1Resources();
        }
    }

    private createEuCentral1Resources(): void {
        // CloudWatch Log Group for SSM Session Manager audit logging
        const ssmLogGroup = new logs.LogGroup(this, 'CedarSSMLogGroup', {
            logGroupName: '/BirchCedar/Maple52/Prod/ssm.log',
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // IAM Role for BirchService
        const birchServiceRole = new iam.Role(this, 'BirchServiceRole', {
            roleName: `BirchServiceRole-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('ssm.amazonaws.com'),
            description: 'IAM role for BirchService SSM operations',
        });

        // IAM Policy for BirchService Role
        const birchServicePolicy = new iam.Policy(this, 'BirchServiceRoleDefaultPolicy', {
            policyName: `BirchServiceRoleDefaultPolicy0574B6B6-${this.account}-${this.region}`,
            statements: [
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'ssm:DescribeDocument',
                        'ssm:DescribeDocumentParameters',
                        'ssm:DescribeDocumentPermission',
                        'ssm:GetCommandInvocation',
                        'ssm:GetDocument',
                        'ssm:ListCommandInvocations',
                        'ssm:ListCommands',
                        'ssm:ListDocuments',
                    ],
                    resources: ['*'],
                }),
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['ssm:SendCommand'],
                    resources: [
                        `arn:aws:ec2:${this.region}:${this.account}:instance/*`,
                        `arn:aws:ssm:${this.region}:${this.account}:document/BirchService-*`,
                    ],
                }),
            ],
        });

        birchServicePolicy.attachToRole(birchServiceRole);

        // SSM Document: BirchService Clear Counters
        new ssm.CfnDocument(this, 'BirchClearCounters', {
            name: `BirchService-clear-counters-${this.account}-${this.region}`,
            documentType: 'Command',
            content: {
                schemaVersion: '2.2',
                description: '/usr/local/ec2/birch/birch-service clear-counters $@',
                parameters: {},
                mainSteps: [
                    {
                        name: 'clearcounters',
                        action: 'aws:runShellScript',
                        inputs: {
                            runCommand: ['/usr/local/ec2/birch/birch-service clear-counters '],
                        },
                    },
                ],
            },
            tags: [
                { key: 'Service', value: 'BirchService' },
                { key: 'Command', value: 'clear-counters' },
            ],
        });

        // SSM Document: BirchService Traffic Stop
        new ssm.CfnDocument(this, 'BirchStopTraffic', {
            name: `BirchService-traffic-stop-${this.account}-${this.region}`,
            documentType: 'Command',
            content: {
                schemaVersion: '2.2',
                description: '/usr/local/ec2/birch/birch-service traffic-stop $@',
                parameters: {
                    args: {
                        type: 'String',
                        description: '(Required) args for traffic-stop',
                        allowedPattern: '^[^;\\\\<>*`&$!#]*$',
                    },
                },
                mainSteps: [
                    {
                        name: 'trafficstop',
                        action: 'aws:runShellScript',
                        inputs: {
                            runCommand: ['/usr/local/ec2/birch/birch-service traffic-stop {{ args }}'],
                        },
                    },
                ],
            },
            tags: [
                { key: 'Service', value: 'BirchService' },
                { key: 'Command', value: 'traffic-stop' },
            ],
        });

        // SSM Document: BirchService Traffic Start
        new ssm.CfnDocument(this, 'BirchStartTraffic', {
            name: `BirchService-traffic-start-${this.account}-${this.region}`,
            documentType: 'Command',
            content: {
                schemaVersion: '2.2',
                description: '/usr/local/ec2/birch/birch-service traffic-start $@',
                parameters: {
                    args: {
                        type: 'String',
                        description: '(Required) args for traffic-start',
                        allowedPattern: '^[^;\\\\<>*`&$!#]*$',
                    },
                },
                mainSteps: [
                    {
                        name: 'trafficstart',
                        action: 'aws:runShellScript',
                        inputs: {
                            runCommand: ['/usr/local/ec2/birch/birch-service traffic-start {{ args }}'],
                        },
                    },
                ],
            },
            tags: [
                { key: 'Service', value: 'BirchService' },
                { key: 'Command', value: 'traffic-start' },
            ],
        });

        // SSM Document: BirchService Set Role
        new ssm.CfnDocument(this, 'BirchSetRole', {
            name: `BirchService-set-role-${this.account}-${this.region}`,
            documentType: 'Command',
            updateMethod: 'NewVersion',
            content: {
                schemaVersion: '2.2',
                description: '/usr/local/ec2/birch/set-role $@',
                parameters: {
                    roleDataJson: {
                        type: 'String',
                        description: '(Required) The role data in json form as previously sent to the service API.',
                        allowedPattern: '^[^;\\\\<>*`&$!#]*$',
                    },
                },
                mainSteps: [
                    {
                        name: 'setrole',
                        action: 'aws:runShellScript',
                        inputs: {
                            runCommand: ["/usr/local/ec2/birch/set-role '{{ roleDataJson }}'"],
                        },
                    },
                ],
            },
            tags: [
                { key: 'Service', value: 'BirchService' },
                { key: 'Command', value: 'set-role' },
            ],
        });

        // SSM Document: BirchService Set Hostname
        new ssm.CfnDocument(this, 'BirchSetHostname', {
            name: `BirchService-set-hostname-${this.account}-${this.region}`,
            documentType: 'Command',
            content: {
                schemaVersion: '2.2',
                description: '/usr/local/ec2/birch/birch-service set-hostname $@',
                parameters: {
                    args: {
                        type: 'String',
                        description: '(Required) args for set-hostname',
                        allowedPattern: '^[^;\\\\<>*`&$!#]*$',
                    },
                },
                mainSteps: [
                    {
                        name: 'sethostname',
                        action: 'aws:runShellScript',
                        inputs: {
                            runCommand: ['/usr/local/ec2/birch/birch-service set-hostname {{ args }}'],
                        },
                    },
                ],
            },
            tags: [
                { key: 'Service', value: 'BirchService' },
                { key: 'Command', value: 'set-hostname' },
            ],
        });

        // SSM Document: Cedar Audit Log (Session Manager)
        new ssm.CfnDocument(this, 'CedarSSMAuditLog', {
            name: `SSM-SessionManagerRunShell-${this.account}-${this.region}`,
            documentType: 'Session',
            updateMethod: 'NewVersion',
            content: {
                schemaVersion: '1.0',
                description: 'Enable session manager audit log to Cloudwatch',
                sessionType: 'Standard_Stream',
                inputs: {
                    cloudWatchEncryptionEnabled: false,
                    s3EncryptionEnabled: false,
                    runAsDefaultUser: '',
                    cloudWatchStreamingEnabled: false,
                    runAsEnabled: false,
                    cloudWatchLogGroupName: ssmLogGroup.logGroupName,
                },
            },
            tags: [
                { key: 'Service', value: 'BirchCedar' },
                { key: 'Purpose', value: 'SSM-Audit' },
            ],
        });

        // Export stack outputs
        StackUtils.exportStack(
            this,
            'BirchServiceRoleName',
            birchServiceRole.roleName,
            'IAM role name for BirchService',
        );
        StackUtils.exportStack(
            this,
            'SSMLogGroupName',
            ssmLogGroup.logGroupName,
            'CloudWatch log group for SSM session audit logs',
        );
        StackUtils.exportStack(
            this,
            'SendCommandEC2Resource',
            `arn:aws:ec2:${this.region}:${this.account}:instance/*`,
            'EC2 resource ARN pattern for ssm:SendCommand',
        );
        StackUtils.exportStack(
            this,
            'SendCommandDocumentResource',
            `arn:aws:ssm:${this.region}:${this.account}:document/BirchService-*`,
            'SSM document resource ARN pattern for ssm:SendCommand',
        );
    }
}
