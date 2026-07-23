import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Aurora PostgreSQL Serverless v2 Stack
 *
 * Inspired by aws-cdk-examples/typescript/postgres-lambda
 * Rewritten to use RDS Data API (no external npm dependencies)
 *
 * Creates:
 * 1. VPC (2 AZs, 1 NAT Gateway, private subnets)
 * 2. Aurora PostgreSQL Serverless v2 cluster (Data API enabled)
 * 3. Secrets Manager secret for DB credentials (auto-generated)
 * 4. Lambda function to query the database via RDS Data API
 * 5. IAM role for RDS-Lambda integration
 */

export class RdsAuroraServerlessStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const vpc = new ec2.Vpc(this, 'AuroraVpc', {
            maxAzs: 2,
            natGateways: 1,
            subnetConfiguration: [
                { cidrMask: 24, name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
                { cidrMask: 24, name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            ],
        });

        const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
            vpc,
            description: 'Security group for Aurora PostgreSQL cluster',
            allowAllOutbound: true,
        });
        dbSecurityGroup.addIngressRule(
            ec2.Peer.ipv4(vpc.vpcCidrBlock),
            ec2.Port.tcp(5432),
            'Allow PostgreSQL from VPC CIDR',
        );

        const dbCluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
            engine: rds.DatabaseClusterEngine.auroraPostgres({
                version: rds.AuroraPostgresEngineVersion.VER_16_8,
            }),
            vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            securityGroups: [dbSecurityGroup],
            writer: rds.ClusterInstance.serverlessV2('writer'),
            serverlessV2MinCapacity: 0.5,
            serverlessV2MaxCapacity: 1,
            defaultDatabaseName: 'appdb',
            credentials: rds.Credentials.fromGeneratedSecret('dbadmin'),
            deletionProtection: false,
            storageEncrypted: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            enableDataApi: true,
        });

        const queryFunction = new lambda.Function(this, 'QueryFunction', {
            functionName: `aurora-query-${this.account}-${this.region}`,
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/rds-aurora-query')),
            environment: {
                CLUSTER_ARN: dbCluster.clusterArn,
                SECRET_ARN: dbCluster.secret?.secretArn || '',
                DATABASE_NAME: 'appdb',
            },
            timeout: cdk.Duration.seconds(30),
        });

        // Grant Lambda access to use RDS Data API
        queryFunction.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['rds-data:ExecuteStatement', 'rds-data:BatchExecuteStatement'],
                resources: [dbCluster.clusterArn],
            }),
        );

        // Grant Lambda read access to the DB secret
        dbCluster.secret?.grantRead(queryFunction);

        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'VPC ID');
        StackUtils.exportStack(this, 'ClusterEndpoint', dbCluster.clusterEndpoint.hostname, 'Aurora cluster endpoint');
        StackUtils.exportStack(this, 'ClusterArn', dbCluster.clusterArn, 'Aurora cluster ARN');
        StackUtils.exportStack(this, 'ClusterIdentifier', dbCluster.clusterIdentifier, 'Aurora cluster identifier');
        StackUtils.exportStack(this, 'SecretArn', dbCluster.secret?.secretArn || '', 'Database credentials secret ARN');
        StackUtils.exportStack(this, 'DatabaseName', 'appdb', 'Default database name');
        StackUtils.exportStack(this, 'FunctionName', queryFunction.functionName, 'Query Lambda function name');
        StackUtils.exportStack(this, 'FunctionArn', queryFunction.functionArn, 'Query Lambda function ARN');
        StackUtils.exportStack(this, 'SecurityGroupId', dbSecurityGroup.securityGroupId, 'DB security group ID');
        StackUtils.exportStack(this, 'EngineVersion', '16.8', 'Aurora PostgreSQL engine version');
    }
}
