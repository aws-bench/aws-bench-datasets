import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: cloudformation-vesgrw3ay
 *
 * 264c9159-9a12-44b8-8db5-446414a25f2a
 *
 * What the stack does:
 * A VPC has one active flow log delivering to S3, but two orphaned CloudWatch Log Groups
 * (from a previously failed stack deployment) make it appear as if flow logs are going to
 * multiple destinations. The agent must identify the single active flow log and explain
 * that the log groups have no active flow logs writing to them.
 *
 * Note: This is a troubleshooting scenario - configurations are intentionally preserved as-is
 */

export class Cloudformation_vesgrw3ay extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const basaltVpc = new ec2.Vpc(this, 'BasaltVPC', {
            ipAddresses: ec2.IpAddresses.cidr('10.2.0.0/16'),
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
            ],
        });

        cdk.Tags.of(basaltVpc).add('Name', 'BasaltVPC');
        cdk.Tags.of(basaltVpc).add('Environment', 'staging');

        const vpcFlowLogsBucket = new s3.Bucket(this, 'VpcFlowLogsBucket', {
            bucketName: `basalt-flowlogs-${this.account}-${this.region}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        // Harden the autoDeleteObjects handler with identity-based S3 grants.
        // By default the handler role's ONLY S3 access is the grant each bucket
        // policy gives its exact role ARN. If that grant is stale or gone at
        // delete time, the handler fails its first call (s3:GetBucketTagging)
        // with AccessDenied, the stack delete force-abandons these FIXED-NAME
        // buckets, and every later deploy fails changeset validation with
        // "already exists" — an unrecoverable reset->redeploy loop. Granting
        // the role directly removes the dependence on bucket-policy survival.
        const autoDeleteProvider = this.node.tryFindChild(
            'Custom::S3AutoDeleteObjectsCustomResourceProvider',
        ) as cdk.CustomResourceProviderBase | undefined;
        autoDeleteProvider?.addToRolePolicy({
            Effect: 'Allow',
            Action: ['s3:GetBucket*', 's3:List*', 's3:DeleteObject*', 's3:PutBucketPolicy'],
            Resource: [
                vpcFlowLogsBucket.bucketArn,
                `${vpcFlowLogsBucket.bucketArn}/*`,
            ],
        });

        const flowLog = new ec2.FlowLog(this, 'VpcFlowLog', {
            resourceType: ec2.FlowLogResourceType.fromVpc(basaltVpc),
            destination: ec2.FlowLogDestination.toS3(vpcFlowLogsBucket),
            trafficType: ec2.FlowLogTrafficType.ALL,
        });

        cdk.Tags.of(flowLog).add('Basalt-Security-Managed', 'VPCFlowLogs');
        cdk.Tags.of(flowLog).add('Name', 'Do-Not-Delete-Basalt-VPCFlowLogs');

        // Orphaned log groups from a failed QuartzStack deployment — no flow logs write to these.
        // Their presence is what makes the VPC appear to have multiple flow log destinations.
        new logs.LogGroup(this, 'OrphanedVpcFlowLogGroup1', {
            logGroupName: 'QuartzStack-Basalt-us-east-1-VpcFlowLogLogGroup1',
            retention: logs.RetentionDays.TWO_YEARS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        new logs.LogGroup(this, 'OrphanedVpcFlowLogGroup2', {
            logGroupName: 'QuartzStack-Basalt-us-east-1-VpcFlowLogLogGroup2',
            retention: logs.RetentionDays.TWO_YEARS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        StackUtils.exportStack(this, 'VpcId', basaltVpc.vpcId, 'The ID of the Basalt VPC');
        StackUtils.exportStack(this, 'FlowLogId', flowLog.flowLogId, 'The ID of the VPC Flow Log');
        StackUtils.exportStack(
            this,
            'VpcFlowLogsBucketName',
            vpcFlowLogsBucket.bucketName,
            'The name of the VPC Flow Logs bucket',
        );
    }
}
