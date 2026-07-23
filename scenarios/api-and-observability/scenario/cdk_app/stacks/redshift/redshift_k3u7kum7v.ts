import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as redshift from 'aws-cdk-lib/aws-redshift';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: redshift-k3u7kum7v
 *
 * de90bdcc-1e81-41ca-92e5-46c68bb65a99
 *
 * What the stack does:
 * 1. Creates VPC infrastructure with public and private subnets, internet gateway, NAT gateway, and route tables
 * 2. Creates multiple security groups for Redshift and SageMaker connectivity
 * 3. Creates a Redshift cluster with encryption in private subnets
 * 4. Creates a SageMaker domain in VPC-only mode in private subnets
 * 5. Creates VPC endpoint for Secrets Manager
 * 6. Creates IAM role for SageMaker execution
 */

export class Redshift_k3u7kum7v extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // Create VPC
        const vpc = new ec2.Vpc(this, 'FlintVpc', {
            vpcName: `flint-vpc-${this.account}-${this.region}`,
            ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
            maxAzs: 2,
            natGateways: 1,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'flint-af-pubsubnet',
                    subnetType: ec2.SubnetType.PUBLIC,
                    mapPublicIpOnLaunch: true,
                },
                {
                    cidrMask: 24,
                    name: 'flint-af-privsubnet',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                },
            ],
        });

        // Get subnets
        const privateSubnet1a = vpc.privateSubnets[0];
        const privateSubnet1b = vpc.privateSubnets[1];

        // Create security group: vpc-internal-sg (sg-redshift-sagemaker)
        const sgRedshiftSagemaker = new ec2.SecurityGroup(this, 'SgRedshiftSagemaker', {
            vpc,
            securityGroupName: `vpc-internal-sg-${this.account}-${this.region}`,
            description: 'Security group for internal VPC connectivity',
            allowAllOutbound: true,
        });

        // intentional: preserved from schema

        // Add inbound rule for Redshift port — SG looks correctly configured in isolation
        // but is not attached to the Redshift cluster (the actual misconfiguration)
        sgRedshiftSagemaker.addIngressRule(
            ec2.Peer.ipv4('10.0.0.0/16'),
            ec2.Port.tcp(8192),
            'Allow Redshift port from VPC',
        );

        // Add egress rule for HTTPS
        sgRedshiftSagemaker.addEgressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(443),
            'Allow HTTPS outbound',
        );

        // Create security group: allow-prod-corp-port-8192-8200 (sg-allow-prod-corp)
        const sgAllowProdCorp = new ec2.SecurityGroup(this, 'SgAllowProdCorp', {
            vpc,
            securityGroupName: `allow-prod-corp-port-8192-8200-${this.account}-${this.region}`,
            description: 'Allow PROD and CORP traffic on port 8192-8200',
            allowAllOutbound: true,
        });

        // intentional: preserved from schema
        sgAllowProdCorp.addIngressRule(
            ec2.Peer.ipv4('172.31.16.0/23'),
            ec2.Port.tcpRange(8192, 8200),
            'Allow from CORP range 1',
        );
        sgAllowProdCorp.addIngressRule(
            ec2.Peer.ipv4('172.31.0.0/20'),
            ec2.Port.tcpRange(8192, 8200),
            'Allow from CORP range 2',
        );

        // Create security group: prod_ranges (sg-prod-ranges)
        const sgProdRanges = new ec2.SecurityGroup(this, 'SgProdRanges', {
            vpc,
            securityGroupName: `prod_ranges-${this.account}-${this.region}`,
            description: 'Prod Ranges',
            allowAllOutbound: true,
        });

        // intentional: preserved from schema
        sgProdRanges.addIngressRule(
            ec2.Peer.ipv4('172.31.16.0/23'),
            ec2.Port.tcpRange(8192, 8200),
            'Allow from CORP range 1',
        );
        sgProdRanges.addIngressRule(
            ec2.Peer.ipv4('172.31.0.0/20'),
            ec2.Port.tcpRange(8192, 8200),
            'Allow from CORP range 2',
        );

        // Create security group: default (sg-default)
        const sgDefault = new ec2.SecurityGroup(this, 'SgDefault', {
            vpc,
            securityGroupName: `default-sg-${this.account}-${this.region}`,
            description: 'default VPC security group',
            allowAllOutbound: true,
        });

        // intentional: preserved from schema
        sgDefault.addIngressRule(
            sgDefault,
            ec2.Port.allTraffic(),
            'Allow self-referencing traffic',
        );

        // Create additional security group for VPC endpoints
        const sgVpcEndpoint = new ec2.SecurityGroup(this, 'SgVpcEndpoint', {
            vpc,
            securityGroupName: `vpc-endpoint-sg-${this.account}-${this.region}`,
            description: 'Security group for VPC endpoints',
            allowAllOutbound: true,
        });

        sgVpcEndpoint.addIngressRule(
            ec2.Peer.ipv4('10.0.0.0/16'),
            ec2.Port.tcp(443),
            'Allow HTTPS from VPC',
        );

        // Create KMS key for Redshift encryption
        const kmsKey = new kms.Key(this, 'RedshiftKmsKey', {
            alias: `flint-redshift-key-${this.account}-${this.region}`,
            description: 'KMS key for Redshift cluster encryption',
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Create Redshift parameter group
        const parameterGroup = new redshift.CfnClusterParameterGroup(this, 'RedshiftParameterGroup', {
            description: 'Parameter group for flint-forecast cluster',
            parameterGroupFamily: 'redshift-1.0',
            parameters: [
                {
                    parameterName: 'require_ssl',
                    parameterValue: 'true',
                },
            ],
        });

        // Create Redshift subnet group
        const subnetGroup = new redshift.CfnClusterSubnetGroup(this, 'RedshiftSubnetGroup', {
            description: 'Subnet group for flint-forecast cluster',
            subnetIds: [privateSubnet1a.subnetId, privateSubnet1b.subnetId],
            tags: [
                {
                    key: 'Name',
                    value: `flint-af-subnet-group-${this.account}-${this.region}`,
                },
            ],
        });

        // Create IAM roles for Redshift
        const redshiftGlueRole = new iam.Role(this, 'RedshiftGlueRole', {
            roleName: `flint-glue-role-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('redshift.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3ReadOnlyAccess'),
            ],
        });

        const redshiftCopyUnloadRole = new iam.Role(this, 'RedshiftCopyUnloadRole', {
            roleName: `RedshiftCopyUnload-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('redshift.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'),
            ],
        });

        // Create Redshift cluster
        const redshiftCluster = new redshift.CfnCluster(this, 'RedshiftCluster', {
            clusterType: 'single-node',
            nodeType: 'ra3.large',
            dbName: 'flintforecast',
            masterUsername: 'flintadmin',
            masterUserPassword: 'Fl1ntR3dsh1ft!',
            clusterIdentifier: `flint-forecast-${this.account}-${this.region}`,
            clusterSubnetGroupName: subnetGroup.attrClusterSubnetGroupName,
            // intentional: preserved from schema
            vpcSecurityGroupIds: [
                sgAllowProdCorp.securityGroupId,
                sgProdRanges.securityGroupId,
                sgDefault.securityGroupId,
                sgVpcEndpoint.securityGroupId,
            ],
            clusterParameterGroupName: parameterGroup.ref,
            encrypted: true,
            kmsKeyId: kmsKey.keyArn,
            publiclyAccessible: false,
            enhancedVpcRouting: false,
            automatedSnapshotRetentionPeriod: 1,
            port: 8192,
            iamRoles: [
                redshiftGlueRole.roleArn,
                redshiftCopyUnloadRole.roleArn,
            ],
        });

        redshiftCluster.addDependency(parameterGroup);
        redshiftCluster.addDependency(subnetGroup);

        // Create SageMaker execution role
        const sagemakerExecutionRole = new iam.Role(this, 'SagemakerExecutionRole', {
            roleName: `AmazonSageMaker-ExecutionRole-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('SecretsManagerReadWrite'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSageMakerFullAccess'),
            ],
        });

        // Create SageMaker domain
        const sagemakerDomain = new sagemaker.CfnDomain(this, 'SagemakerDomain', {
            domainName: `flint-forecast-sagemaker-domain-${this.account}-${this.region}`,
            authMode: 'IAM',
            vpcId: vpc.vpcId,
            subnetIds: [privateSubnet1a.subnetId, privateSubnet1b.subnetId],
            appNetworkAccessType: 'VpcOnly',
            defaultUserSettings: {
                executionRole: sagemakerExecutionRole.roleArn,
                securityGroups: [sgRedshiftSagemaker.securityGroupId],
            },
            domainSettings: {
                securityGroupIds: [
                    sgAllowProdCorp.securityGroupId,
                    sgProdRanges.securityGroupId,
                    sgDefault.securityGroupId,
                ],
            },
        });

        // Create VPC endpoint for Secrets Manager
        // intentional: preserved from schema
        const secretsManagerEndpoint = new ec2.InterfaceVpcEndpoint(this, 'SecretsManagerEndpoint', {
            vpc,
            service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
            subnets: { subnets: [privateSubnet1a, privateSubnet1b] },
            securityGroups: [
                sgVpcEndpoint,
                sgAllowProdCorp,
                sgDefault,
            ],
            privateDnsEnabled: true,
        });

        // Export stack outputs
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'The ID of the VPC');
        StackUtils.exportStack(this, 'PrivateSubnet1aId', privateSubnet1a.subnetId, 'Private subnet 1a ID');
        StackUtils.exportStack(this, 'PrivateSubnet1bId', privateSubnet1b.subnetId, 'Private subnet 1b ID');
        StackUtils.exportStack(this, 'SgRedshiftSagemakerId', sgRedshiftSagemaker.securityGroupId, 'SageMaker-Redshift security group ID');
        StackUtils.exportStack(this, 'SgAllowProdCorpId', sgAllowProdCorp.securityGroupId, 'Allow prod corp security group ID');
        StackUtils.exportStack(this, 'SgProdRangesId', sgProdRanges.securityGroupId, 'Prod ranges security group ID');
        StackUtils.exportStack(this, 'SgDefaultId', sgDefault.securityGroupId, 'Default security group ID');
        StackUtils.exportStack(this, 'SgVpcEndpointId', sgVpcEndpoint.securityGroupId, 'VPC endpoint security group ID');
        StackUtils.exportStack(this, 'RedshiftClusterIdentifier', redshiftCluster.clusterIdentifier!, 'Redshift cluster identifier');
        StackUtils.exportStack(this, 'RedshiftClusterEndpoint', redshiftCluster.attrEndpointAddress, 'Redshift cluster endpoint');
        StackUtils.exportStack(this, 'RedshiftClusterPort', redshiftCluster.attrEndpointPort, 'Redshift cluster port');
        StackUtils.exportStack(this, 'SagemakerDomainId', sagemakerDomain.attrDomainId, 'SageMaker domain ID');
        StackUtils.exportStack(this, 'SagemakerExecutionRoleArn', sagemakerExecutionRole.roleArn, 'SageMaker execution role ARN');
        StackUtils.exportStack(this, 'SecretsManagerEndpointId', secretsManagerEndpoint.vpcEndpointId, 'Secrets Manager VPC endpoint ID');
    }
}
