import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as transfer from 'aws-cdk-lib/aws-transfer';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Transfer SFTP Server Stack
 *
 * Converted from aws-cdk-examples/typescript/aws-transfer-sftp-server
 *
 * Creates:
 * 1. VPC (maxAzs 2, no NAT gateways)
 * 2. Security Group (allow port 22 from 10.0.0.0/8 only)
 * 3. S3 Bucket for SFTP data
 * 4. IAM Roles for Transfer logging and SFTP user
 * 5. CloudWatch LogGroup
 * 6. Transfer Family SFTP server (VPC endpoint)
 * 7. Elastic IPs (2, one per AZ)
 * 8. SFTP User
 * 9. CloudWatch Metric Filter and Alarm
 */

export class TransferSftpServerStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // VPC
        const vpc = new ec2.Vpc(this, 'SftpVpc', {
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                    cidrMask: 24,
                },
            ],
        });

        // Security Group - restrict to 10.0.0.0/8
        const securityGroup = new ec2.SecurityGroup(this, 'SftpSecurityGroup', {
            vpc,
            description: 'Security group for SFTP Transfer server',
            allowAllOutbound: true,
        });
        securityGroup.addIngressRule(
            ec2.Peer.ipv4('10.0.0.0/8'),
            ec2.Port.tcp(22),
            'Allow SFTP access from internal network only',
        );

        // S3 Bucket for SFTP data
        const bucket = new s3.Bucket(this, 'SftpDataBucket', {
            bucketName: `sftp-data-${this.account}-${this.region}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            versioned: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        // Harden the autoDeleteObjects handler with identity-based S3 grants.
        // By default the handler role's ONLY S3 access is the grant the bucket
        // policy gives its exact role ARN. If that grant is stale or gone at
        // delete time, the handler fails its first call (s3:GetBucketTagging)
        // with AccessDenied, the stack delete force-abandons this FIXED-NAME
        // bucket, and every later deploy fails changeset validation with
        // "already exists" — an unrecoverable reset->redeploy loop. Granting
        // the role directly removes the dependence on bucket-policy survival.
        const autoDeleteProvider = this.node.tryFindChild(
            'Custom::S3AutoDeleteObjectsCustomResourceProvider',
        ) as cdk.CustomResourceProviderBase | undefined;
        autoDeleteProvider?.addToRolePolicy({
            Effect: 'Allow',
            Action: ['s3:GetBucket*', 's3:List*', 's3:DeleteObject*', 's3:PutBucketPolicy'],
            Resource: [
                bucket.bucketArn,
                `${bucket.bucketArn}/*`,
            ],
        });

        // IAM Role for Transfer logging
        const loggingRole = new iam.Role(this, 'TransferLoggingRole', {
            assumedBy: new iam.ServicePrincipal('transfer.amazonaws.com'),
            description: 'IAM role for Transfer Family CloudWatch logging',
        });
        loggingRole.addToPolicy(
            new iam.PolicyStatement({
                actions: [
                    'logs:CreateLogGroup',
                    'logs:CreateLogStream',
                    'logs:PutLogEvents',
                    'logs:DescribeLogStreams',
                ],
                resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/transfer/*`],
            }),
        );

        // IAM Role for SFTP user
        const sftpUserRole = new iam.Role(this, 'SftpUserRole', {
            assumedBy: new iam.ServicePrincipal('transfer.amazonaws.com'),
            description: 'IAM role for SFTP user S3 access',
        });
        bucket.grantReadWrite(sftpUserRole);

        // CloudWatch LogGroup
        const logGroup = new logs.LogGroup(this, 'SftpLogGroup', {
            logGroupName: `/aws/transfer/sftp-server-${this.account}`,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Elastic IPs (one per AZ)
        const eip1 = new ec2.CfnEIP(this, 'SftpEip1', {
            domain: 'vpc',
        });
        eip1.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        const eip2 = new ec2.CfnEIP(this, 'SftpEip2', {
            domain: 'vpc',
        });
        eip2.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Transfer Family SFTP Server (VPC endpoint)
        const server = new transfer.CfnServer(this, 'SftpServer', {
            endpointType: 'VPC',
            protocols: ['SFTP'],
            identityProviderType: 'SERVICE_MANAGED',
            loggingRole: loggingRole.roleArn,
            endpointDetails: {
                vpcId: vpc.vpcId,
                subnetIds: vpc.publicSubnets.map((subnet) => subnet.subnetId),
                securityGroupIds: [securityGroup.securityGroupId],
                addressAllocationIds: [eip1.attrAllocationId, eip2.attrAllocationId],
            },
        });
        server.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // SFTP User. No SSH keys are attached at creation time — real keys can be added
        // later via ImportSshPublicKey if interactive SFTP access is needed.
        const sftpUser = new transfer.CfnUser(this, 'SftpUser', {
            serverId: server.attrServerId,
            userName: 'sftp-user',
            role: sftpUserRole.roleArn,
            homeDirectoryType: 'LOGICAL',
            homeDirectoryMappings: [
                {
                    entry: '/',
                    target: `/${bucket.bucketName}/sftp-user`,
                },
            ],
        });
        sftpUser.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // CloudWatch Metric Filter for errors
        const metricFilter = new logs.MetricFilter(this, 'SftpErrorMetricFilter', {
            logGroup,
            filterPattern: logs.FilterPattern.literal('ERROR'),
            metricNamespace: 'SFTP/Transfer',
            metricName: 'SftpErrors',
            metricValue: '1',
            defaultValue: 0,
        });

        // CloudWatch Alarm
        const alarm = new cloudwatch.Alarm(this, 'SftpErrorAlarm', {
            alarmName: `sftp-error-alarm-${this.account}-${this.region}`,
            alarmDescription: 'Alarm when SFTP transfer errors exceed threshold',
            metric: metricFilter.metric({
                statistic: 'Sum',
                period: cdk.Duration.minutes(5),
            }),
            threshold: 1,
            evaluationPeriods: 5,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        // Exports
        StackUtils.exportStack(this, 'ServerEndpoint', `${server.attrServerId}.server.transfer.${this.region}.amazonaws.com`, 'SFTP server endpoint');
        StackUtils.exportStack(this, 'ServerId', server.attrServerId, 'Transfer Family server ID');
        StackUtils.exportStack(this, 'ServerArn', server.attrArn, 'Transfer Family server ARN');
        StackUtils.exportStack(this, 'BucketName', bucket.bucketName, 'S3 bucket name for SFTP data');
        StackUtils.exportStack(this, 'BucketArn', bucket.bucketArn, 'S3 bucket ARN for SFTP data');
        StackUtils.exportStack(this, 'UserName', sftpUser.userName, 'SFTP user name');
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'VPC ID for SFTP server');
        StackUtils.exportStack(this, 'SecurityGroupId', securityGroup.securityGroupId, 'Security group ID for SFTP server');
        StackUtils.exportStack(this, 'LogGroupName', logGroup.logGroupName, 'CloudWatch log group name');
        StackUtils.exportStack(this, 'AlarmName', alarm.alarmName, 'CloudWatch alarm name for SFTP errors');
        StackUtils.exportStack(this, 'Protocol', 'SFTP', 'Transfer protocol');
        StackUtils.exportStack(this, 'EndpointType', 'VPC', 'Server endpoint type');
        StackUtils.exportStack(this, 'AllowedIps', '10.0.0.0/8', 'Allowed IP range for SFTP access');
    }
}
