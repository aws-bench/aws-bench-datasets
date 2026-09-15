import * as cdk from 'aws-cdk-lib';
import * as redshift from 'aws-cdk-lib/aws-redshift';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Construct } from 'constructs';

import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: redshift-wfic8j0dt
 *
 * 41f6df3d-2f05-44d3-82af-8cccf7116f44
 *
 * What the stack does:
 * 1. Creates VPC infrastructure with subnets and security groups
 * 2. Creates KMS key for Redshift encryption
 * 3. Creates IAM roles for Redshift Spectrum
 * 4. Creates Redshift parameter group and subnet group
 * 5. Creates two Redshift clusters (adhoc and global) with single nodes
 * 6. Creates CloudWatch alarms to monitor cluster health and CPU utilization
 * 7. Creates SNS topic for critical alarm notifications
 *
 * Note: This is a troubleshooting scenario - the GlobalHealthAllAlarm uses the wrong
 * comparison operator (GREATER_THAN_THRESHOLD instead of LESS_THAN_THRESHOLD), so it
 * fires continuously when the cluster is healthy (HealthStatus 1.0 > 0.5).
 */

export class Redshift_wfic8j0dt extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // Create VPC
        const vpc = new ec2.Vpc(this, 'VPC', {
            vpcName: `vpc-${this.account}-${this.region}`,
            maxAzs: 2,
            natGateways: 1,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
                {
                    cidrMask: 24,
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                },
            ],
        });

        // Create security groups
        const securityGroup1 = new ec2.SecurityGroup(this, 'SecurityGroup1', {
            vpc,
            securityGroupName: `redshift-sg-1-${this.account}-${this.region}`,
            description: 'Security group 1 for Redshift clusters',
            allowAllOutbound: true,
        });

        const securityGroup2 = new ec2.SecurityGroup(this, 'SecurityGroup2', {
            vpc,
            securityGroupName: `redshift-sg-2-${this.account}-${this.region}`,
            description: 'Security group 2 for Redshift clusters',
            allowAllOutbound: true,
        });

        const securityGroup3 = new ec2.SecurityGroup(this, 'SecurityGroup3', {
            vpc,
            securityGroupName: `redshift-sg-3-${this.account}-${this.region}`,
            description: 'Security group 3 for Redshift clusters',
            allowAllOutbound: true,
        });

        const securityGroup4 = new ec2.SecurityGroup(this, 'SecurityGroup4', {
            vpc,
            securityGroupName: `redshift-sg-4-${this.account}-${this.region}`,
            description: 'Security group 4 for Redshift clusters',
            allowAllOutbound: true,
        });

        const securityGroup5 = new ec2.SecurityGroup(this, 'SecurityGroup5', {
            vpc,
            securityGroupName: `redshift-sg-5-${this.account}-${this.region}`,
            description: 'Security group 5 for Redshift clusters',
            allowAllOutbound: true,
        });

        // Create KMS key for Redshift encryption
        const kmsKey = new kms.Key(this, 'RedshiftKMSKey', {
            alias: `redshift-encryption-key-${this.account}-${this.region}`,
            description: 'KMS key for Redshift cluster encryption',
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Create IAM roles for Redshift Spectrum
        const spectrumLakeFormationRole = new iam.Role(this, 'SpectrumLakeFormationRole', {
            roleName: 'QuartzLakeFormationRole',
            assumedBy: new iam.ServicePrincipal('redshift.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3ReadOnlyAccess')],
        });

        const flintSpectrumRole = new iam.Role(this, 'FlintSpectrumRole', {
            roleName: 'QuartzFlintRole',
            assumedBy: new iam.ServicePrincipal('redshift.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3ReadOnlyAccess')],
        });

        const basaltSpectrumRole = new iam.Role(this, 'BasaltSpectrumRole', {
            roleName: 'QuartzBasaltRole',
            assumedBy: new iam.ServicePrincipal('redshift.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3ReadOnlyAccess')],
        });

        // Create Redshift parameter group
        const parameterGroup = new redshift.CfnClusterParameterGroup(this, 'RedshiftParameterGroup', {
            description: 'Parameter group for Redshift clusters',
            parameterGroupFamily: 'redshift-1.0',
            parameters: [
                {
                    parameterName: 'enable_user_activity_logging',
                    parameterValue: 'true',
                },
                {
                    parameterName: 'require_ssl',
                    parameterValue: 'true',
                },
                {
                    parameterName: 'use_fips_ssl',
                    parameterValue: 'false',
                },
                {
                    parameterName: 'auto_analyze',
                    parameterValue: 'true',
                },
                {
                    parameterName: 'max_concurrency_scaling_clusters',
                    parameterValue: '1',
                },
                {
                    parameterName: 'enable_case_sensitive_identifier',
                    parameterValue: 'false',
                },
                {
                    parameterName: 'auto_mv',
                    parameterValue: 'true',
                },
            ],
        });

        // Create Redshift subnet group
        const subnetGroup = new redshift.CfnClusterSubnetGroup(this, 'RedshiftSubnetGroup', {
            description: 'Subnet group for Redshift clusters',
            subnetIds: vpc.privateSubnets.map((subnet) => subnet.subnetId),
        });

        // Create Redshift cluster - adhoc (reduced to single node for cost savings)
        const adhocCluster = new redshift.CfnCluster(this, 'RedshiftClusterAdhoc', {
            clusterType: 'single-node',
            nodeType: 'ra3.xlplus',
            dbName: 'quartzdb',
            masterUsername: 'quartz_etl',
            masterUserPassword: 'TempPassword123!',
            clusterIdentifier: `quartz-adhoc1-${this.account}-${this.region}`,
            clusterSubnetGroupName: subnetGroup.ref,
            vpcSecurityGroupIds: [
                securityGroup1.securityGroupId,
                securityGroup2.securityGroupId,
                securityGroup3.securityGroupId,
                securityGroup4.securityGroupId,
                securityGroup5.securityGroupId,
            ],
            clusterParameterGroupName: parameterGroup.ref,
            encrypted: true,
            kmsKeyId: kmsKey.keyArn,
            publiclyAccessible: false,
            enhancedVpcRouting: false,
            automatedSnapshotRetentionPeriod: 1,
            manualSnapshotRetentionPeriod: -1,
            allowVersionUpgrade: true,
            maintenanceTrackName: 'trailing',
            preferredMaintenanceWindow: 'wed:04:00-wed:04:30',
            iamRoles: [spectrumLakeFormationRole.roleArn, flintSpectrumRole.roleArn, basaltSpectrumRole.roleArn],
            tags: [
                {
                    key: 'quartz-service',
                    value: 'QuartzGarnet',
                },
            ],
        });

        adhocCluster.addDependency(parameterGroup);
        adhocCluster.addDependency(subnetGroup);

        // Create Redshift cluster - global (reduced to single node for cost savings)
        const globalCluster = new redshift.CfnCluster(this, 'RedshiftClusterGlobal', {
            clusterType: 'single-node',
            nodeType: 'ra3.xlplus',
            dbName: 'quartzdb',
            masterUsername: 'quartz_etl',
            masterUserPassword: 'TempPassword123!',
            clusterIdentifier: `quartz-global-basalt1-${this.account}-${this.region}`,
            clusterSubnetGroupName: subnetGroup.ref,
            vpcSecurityGroupIds: [
                securityGroup1.securityGroupId,
                securityGroup2.securityGroupId,
                securityGroup3.securityGroupId,
                securityGroup4.securityGroupId,
                securityGroup5.securityGroupId,
            ],
            clusterParameterGroupName: parameterGroup.ref,
            encrypted: true,
            kmsKeyId: kmsKey.keyArn,
            publiclyAccessible: false,
            enhancedVpcRouting: false,
            automatedSnapshotRetentionPeriod: 1,
            manualSnapshotRetentionPeriod: -1,
            allowVersionUpgrade: true,
            maintenanceTrackName: 'trailing',
            preferredMaintenanceWindow: 'wed:04:00-wed:04:30',
            iamRoles: [spectrumLakeFormationRole.roleArn, flintSpectrumRole.roleArn, basaltSpectrumRole.roleArn],
            tags: [
                {
                    key: 'quartz-service',
                    value: 'QuartzGarnet',
                },
            ],
        });

        globalCluster.addDependency(parameterGroup);
        globalCluster.addDependency(subnetGroup);

        // Create SNS topic for critical alarms
        const snsTopic = new sns.Topic(this, 'RedshiftCriticalTopic', {
            topicName: `quartz-redshift-critical-${this.account}-${this.region}`,
            displayName: 'Redshift Production Critical Alarms',
        });

        // Create CloudWatch alarm for adhoc cluster CPU utilization
        const adhocCpuAlarm = new cloudwatch.Alarm(this, 'AdhocCPUAlarm', {
            alarmName: `quartz-adhoc1-CPUUtilization-${this.account}-${this.region}`,
            metric: new cloudwatch.Metric({
                namespace: 'AWS/Redshift',
                metricName: 'CPUUtilization',
                dimensionsMap: {
                    ClusterIdentifier: adhocCluster.clusterIdentifier!,
                },
                statistic: 'Average',
                period: cdk.Duration.minutes(5),
            }),
            threshold: 95.0,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            actionsEnabled: true,
        });

        adhocCpuAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(snsTopic));

        // Create CloudWatch alarm for global cluster health (all nodes)
        const globalHealthAllAlarm = new cloudwatch.Alarm(this, 'GlobalHealthAllAlarm', {
            alarmName: `quartz-global-basalt1-HealthStatus-All-${this.account}-${this.region}`,
            alarmDescription: 'Alarm for quartz-global-basalt1 when cluster is unhealthy for more than 5 minutes',
            metric: new cloudwatch.Metric({
                namespace: 'AWS/Redshift',
                metricName: 'HealthStatus',
                dimensionsMap: {
                    ClusterIdentifier: globalCluster.clusterIdentifier!,
                },
                statistic: 'Average',
                period: cdk.Duration.minutes(5),
            }),
            threshold: 0.5,
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            actionsEnabled: true,
        });

        // Create CloudWatch alarm for global cluster health (leader node)
        const globalHealthLeaderAlarm = new cloudwatch.Alarm(this, 'GlobalHealthLeaderAlarm', {
            alarmName: `quartz-global-basalt1-HealthStatus-Leader-${this.account}-${this.region}`,
            alarmDescription:
                "Alarm for when quartz-global-basalt1 cluster's Leader Node is unhealthy for more than 5 minutes",
            metric: new cloudwatch.Metric({
                namespace: 'AWS/Redshift',
                metricName: 'HealthStatus',
                dimensionsMap: {
                    ClusterIdentifier: globalCluster.clusterIdentifier!,
                    NodeID: 'Leader',
                },
                statistic: 'Average',
                period: cdk.Duration.minutes(30),
            }),
            threshold: 1.0,
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
            actionsEnabled: true,
        });

        // Export stack outputs
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'The ID of the VPC');
        StackUtils.exportStack(
            this,
            'AdhocClusterIdentifier',
            adhocCluster.clusterIdentifier!,
            'The identifier of the adhoc Redshift cluster',
        );
        StackUtils.exportStack(
            this,
            'GlobalClusterIdentifier',
            globalCluster.clusterIdentifier!,
            'The identifier of the global Redshift cluster',
        );
        StackUtils.exportStack(
            this,
            'AdhocClusterEndpoint',
            adhocCluster.attrEndpointAddress,
            'The endpoint address of the adhoc Redshift cluster',
        );
        StackUtils.exportStack(
            this,
            'GlobalClusterEndpoint',
            globalCluster.attrEndpointAddress,
            'The endpoint address of the global Redshift cluster',
        );
        StackUtils.exportStack(this, 'KMSKeyId', kmsKey.keyId, 'The ID of the KMS key for Redshift encryption');
        StackUtils.exportStack(this, 'SNSTopicArn', snsTopic.topicArn, 'The ARN of the SNS topic for critical alarms');
        StackUtils.exportStack(
            this,
            'AdhocCPUAlarmName',
            adhocCpuAlarm.alarmName,
            'The name of the adhoc cluster CPU alarm',
        );
        StackUtils.exportStack(
            this,
            'GlobalHealthAllAlarmName',
            globalHealthAllAlarm.alarmName,
            'The name of the global cluster health alarm (all nodes)',
        );
        StackUtils.exportStack(
            this,
            'GlobalHealthLeaderAlarmName',
            globalHealthLeaderAlarm.alarmName,
            'The name of the global cluster health alarm (leader node)',
        );
    }
}
