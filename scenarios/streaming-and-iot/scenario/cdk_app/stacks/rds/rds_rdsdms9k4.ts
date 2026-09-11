import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3tables from 'aws-cdk-lib/aws-s3tables';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: rds_rdsdms9k4
 *
 * Precondition for the dms-rds-to-s3-tables-pipeline task.
 *
 * Frugal split: pre-deploy RDS MySQL + S3 Tables bucket + ZeroETL role +
 * VPC. The agent creates the DMS replication instance, source/target
 * endpoints, and the replication task. We don't pre-deploy DMS because
 * a replication instance is ~$0.15/hr idle -- we want it to live only
 * for the duration of an evaluation run.
 *
 * RDS instance: db.t3.micro, MySQL 8.0, public subnet in single AZ.
 * Cheapest production-ish configuration.
 */
export class rds_rdsdms9k4 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const vpc = new ec2.Vpc(this, 'RdsVpc', {
            ipAddresses: ec2.IpAddresses.cidr('10.60.0.0/16'),
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
                { name: 'private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
            ],
            restrictDefaultSecurityGroup: false,
        });

        // RDS subnet group across the two AZs (RDS requires ≥2 AZs even for
        // single-instance deployments -- the standby is implicit).
        const subnetGroup = new rds.SubnetGroup(this, 'DbSubnetGroup', {
            vpc,
            description: 'Subnet group for the MySQL instance',
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        });

        const parameterGroup = new rds.ParameterGroup(this, 'AppMysqlParams', {
            engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0 }),
            description: 'ROW-based binlog so DMS CDC can tail the MySQL binlog',
            parameters: {
                binlog_format: 'ROW',
                binlog_row_image: 'FULL',
            },
        });

        const dbSg = new ec2.SecurityGroup(this, 'DbSg', {
            vpc,
            description: 'Permits MySQL traffic from inside the VPC',
            allowAllOutbound: false,
        });
        dbSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(3306), 'MySQL from VPC');

        const db = new rds.DatabaseInstance(this, 'AppMysql', {
            engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0 }),
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            vpc,
            subnetGroup,
            securityGroups: [dbSg],
            parameterGroup,
            databaseName: 'testdb',
            credentials: rds.Credentials.fromGeneratedSecret('admin', {
                secretName: `app-mysql-creds-${this.account.slice(-6)}`,
            }),
            allocatedStorage: 20,
            storageType: rds.StorageType.GP2,
            multiAz: false,
            backupRetention: cdk.Duration.days(1),
            deletionProtection: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            publiclyAccessible: false,
        });

        // S3 Tables bucket. The agent uses this as the DMS replication
        // target -- S3 Tables is the Iceberg-managed storage product.
        const tablesBucket = new s3tables.CfnTableBucket(this, 'TablesBucket', {
            tableBucketName: `app-tables-${this.account.slice(-6)}`,
        });
        tablesBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // ZeroETL role: agent attaches it to the DMS replication task.
        const zeroEtlRole = new iam.Role(this, 'ZeroEtlRole', {
            roleName: `zero-etl-role-${this.account.slice(-6)}`,
            assumedBy: new iam.ServicePrincipal('dms.amazonaws.com'),
        });
        zeroEtlRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['secretsmanager:GetSecretValue'],
                resources: [db.secret!.secretArn],
            }),
        );
        zeroEtlRole.addToPolicy(
            new iam.PolicyStatement({
                actions: [
                    's3tables:PutTableData',
                    's3tables:GetTableMetadataLocation',
                    's3tables:UpdateTableMetadataLocation',
                    's3tables:GetTable',
                    's3tables:CreateTable',
                ],
                resources: [tablesBucket.attrTableBucketArn, `${tablesBucket.attrTableBucketArn}/*`],
            }),
        );

        StackUtils.exportStack(this, 'MySQLEndpoint', db.dbInstanceEndpointAddress, 'RDS MySQL endpoint');
        StackUtils.exportStack(this, 'MySQLPort', db.dbInstanceEndpointPort, 'RDS MySQL port');
        StackUtils.exportStack(this, 'MySQLSecretArn', db.secret!.secretArn, 'Master credentials secret');
        StackUtils.exportStack(this, 'S3TablesBucketArn', tablesBucket.attrTableBucketArn, 'S3 Tables target bucket');
        StackUtils.exportStack(this, 'ZeroETLRoleName', zeroEtlRole.roleName, 'IAM role DMS uses');
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'VPC for the DMS replication instance');
    }
}
