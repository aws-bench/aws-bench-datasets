import * as cdk from 'aws-cdk-lib';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { Stack as DeploymentStack, StackProps as DeploymentStackProps } from 'aws-cdk-lib';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: rds-dbu3efc8j
 *
 * 6e6874c6-0bf6-438b-909a-ff1d5a94f37d
 *
 * What the stack does:
 * 1. Creates an Aurora PostgreSQL cluster with writer and reader instances
 * 2. Configures Performance Insights with KMS encryption
 * 3. Enables Enhanced Monitoring with IAM role
 * 4. Exports CloudWatch logs for PostgreSQL
 * 5. Configures cluster and DB subnet groups
 *
 * Note: This is an introspection scenario - configurations are intentionally preserved as-is
 */

export class Rds_dbu3efc8j extends DeploymentStack {

    constructor(scope: Construct, id: string, props: DeploymentStackProps) {
        super(scope, id, props);


        // Create VPC - using default VPC lookup
        const vpc = ec2.Vpc.fromLookup(this, 'VPC', {
            isDefault: true,
        });

        // Create security group for Aurora cluster
        const securityGroup = new ec2.SecurityGroup(this, 'AuroraSecurityGroup', {
            vpc: vpc,
            description: 'Security group for Aurora PostgreSQL cluster',
            securityGroupName: `aurora-security-group-${this.account}-${this.region}`,
        });

        // Create KMS key for Performance Insights encryption
        const performanceInsightsKey = new kms.Key(this, 'PerformanceInsightsKey', {
            description: 'KMS key for Aurora Performance Insights encryption',
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Create IAM role for Enhanced Monitoring
        const monitoringRole = new iam.Role(this, 'EnhancedMonitoringRole', {
            assumedBy: new iam.ServicePrincipal('monitoring.rds.amazonaws.com'),
            description: 'IAM role for RDS Enhanced Monitoring',
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonRDSEnhancedMonitoringRole'),
            ],
        });

        // Create DB subnet group
        const subnetGroup = new rds.SubnetGroup(this, 'DBSubnetGroup', {
            description: 'Subnet group for Aurora PostgreSQL cluster',
            vpc: vpc,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PUBLIC,
            },
            subnetGroupName: `Basalt-db-subnet-group-${this.account}-${this.region}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Create cluster parameter group
        const clusterParameterGroup = new rds.ParameterGroup(this, 'ClusterParameterGroup', {
            engine: rds.DatabaseClusterEngine.auroraPostgres({
                version: rds.AuroraPostgresEngineVersion.of('17.4', '17'),
            }),
            description: 'Parameter group for Aurora PostgreSQL cluster',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Create Aurora PostgreSQL cluster
        const cluster = new rds.DatabaseCluster(this, 'AuroraPostgreCluster', {
            engine: rds.DatabaseClusterEngine.auroraPostgres({
                version: rds.AuroraPostgresEngineVersion.of('17.4', '17'),
            }),
            credentials: rds.Credentials.fromGeneratedSecret('postgres'),
            writer: rds.ClusterInstance.provisioned('writer', {
                instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
                publiclyAccessible: false,
                promotionTier: 1,
                autoMinorVersionUpgrade: false,
            }),
            readers: [
                rds.ClusterInstance.provisioned('reader', {
                    instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
                    publiclyAccessible: false,
                    promotionTier: 1,
                    autoMinorVersionUpgrade: false,
                }),
            ],
            vpc: vpc,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PUBLIC,
            },
            securityGroups: [securityGroup],
            subnetGroup: subnetGroup,
            parameterGroup: clusterParameterGroup,
            port: 5432,
            backup: {
                retention: cdk.Duration.days(7),
                preferredWindow: '03:00-04:00',
            },
            preferredMaintenanceWindow: 'sun:04:00-sun:05:00',
            storageEncrypted: false,
            deletionProtection: false,
            cloudwatchLogsExports: ['postgresql'],
            cloudwatchLogsRetention: cdk.aws_logs.RetentionDays.ONE_WEEK,
            monitoringInterval: cdk.Duration.seconds(60),
            monitoringRole: monitoringRole,
            enablePerformanceInsights: true,
            performanceInsightEncryptionKey: performanceInsightsKey,
            performanceInsightRetention: rds.PerformanceInsightRetention.LONG_TERM,
            iamAuthentication: false,
            copyTagsToSnapshot: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            clusterIdentifier: `Basalt-postgre-cluster-${this.account}-${this.region}`,
        });

        // Note: HTTP endpoint for Data API is not enabled because T3 instance class doesn't support it

        // Add tags
        cdk.Tags.of(cluster).add('Name', `Basalt-postgre-cluster-${this.account}-${this.region}`);

        // Export cluster information
        StackUtils.exportStack(
            this,
            'ClusterIdentifier',
            cluster.clusterIdentifier,
            'The identifier of the Aurora PostgreSQL cluster',
        );
        StackUtils.exportStack(
            this,
            'ClusterEndpoint',
            cluster.clusterEndpoint.hostname,
            'The cluster endpoint for write operations',
        );
        StackUtils.exportStack(
            this,
            'ClusterReadEndpoint',
            cluster.clusterReadEndpoint.hostname,
            'The cluster reader endpoint for read operations',
        );
        StackUtils.exportStack(this, 'ClusterArn', cluster.clusterArn, 'The ARN of the Aurora PostgreSQL cluster');
        StackUtils.exportStack(
            this,
            'SecurityGroupId',
            securityGroup.securityGroupId,
            'The security group ID for the Aurora cluster',
        );
        StackUtils.exportStack(
            this,
            'PerformanceInsightsKeyId',
            performanceInsightsKey.keyId,
            'The KMS key ID for Performance Insights encryption',
        );
        StackUtils.exportStack(
            this,
            'MonitoringRoleArn',
            monitoringRole.roleArn,
            'The IAM role ARN for Enhanced Monitoring',
        );
    }
}
