import * as cdk from 'aws-cdk-lib';
import * as emr from 'aws-cdk-lib/aws-emr';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: emr-0hr2dw3rz
 *
 * 1207cfc5-aebc-47e3-89d7-d8d9afac53a2
 *
 * What the stack does:
 * 1. Creates a VPC with public and private subnets and security groups for EMR cluster networking
 * 2. Creates IAM roles and instance profiles for EMR service and EC2 instances
 * 3. Creates a KMS key for S3 client-side encryption (EMRFS)
 * 4. Creates an S3 bucket for EMR logs
 * 5. Creates an EMR cluster configured with Spark, Hadoop, Zeppelin, and Pig applications (intentionally misconfigured)
 *
 * Note: This is a troubleshooting scenario - configurations are intentionally preserved as-is
 */

export class Emr_0hr2dw3rz extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // ========================================
        // VPC and Networking Resources
        // ========================================

        const vpc = new ec2.Vpc(this, 'EmrVpc', {
            vpcName: `emr-vpc-${this.account}-${this.region}`,
            maxAzs: 3,
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

        // EMR Managed Security Groups
        const emrManagedPrimarySG = new ec2.SecurityGroup(this, 'EmrManagedPrimarySG', {
            vpc,
            description: 'EMR managed security group for primary nodes',
            securityGroupName: `emr-primary-sg-${this.account}-${this.region}`,
        });

        const emrManagedCoreSG = new ec2.SecurityGroup(this, 'EmrManagedCoreSG', {
            vpc,
            description: 'EMR managed security group for core nodes',
            securityGroupName: `emr-core-sg-${this.account}-${this.region}`,
        });

        const serviceAccessSG = new ec2.SecurityGroup(this, 'ServiceAccessSG', {
            vpc,
            description: 'EMR service access security group',
            securityGroupName: `emr-service-access-sg-${this.account}-${this.region}`,
        });

        const additionalSG = new ec2.SecurityGroup(this, 'AdditionalSG', {
            vpc,
            description: 'Additional security group for EMR nodes',
            securityGroupName: `emr-additional-sg-${this.account}-${this.region}`,
        });

        // Allow communication between primary and core nodes
        emrManagedPrimarySG.addIngressRule(
            emrManagedCoreSG,
            ec2.Port.allTraffic(),
            'Allow all traffic from core nodes',
        );
        emrManagedCoreSG.addIngressRule(
            emrManagedPrimarySG,
            ec2.Port.allTraffic(),
            'Allow all traffic from primary node',
        );

        // Allow EMR service to communicate with primary node on port 9443
        serviceAccessSG.addIngressRule(
            emrManagedPrimarySG,
            ec2.Port.tcp(9443),
            'Allow EMR service access from primary node on port 9443',
        );

        // ========================================
        // KMS Key for S3 Encryption
        // ========================================

        const s3EncryptionKey = new kms.Key(this, 'S3EncryptionKey', {
            description: 'KMS key for EMR S3 client-side encryption (EMRFS)',
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // ========================================
        // S3 Buckets
        // ========================================

        // Logs bucket
        const logsBucket = new s3.Bucket(this, 'EmrLogsBucket', {
            bucketName: `basalt-logs-${this.account}-${this.region}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            versioned: false,
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
                logsBucket.bucketArn,
                `${logsBucket.bucketArn}/*`,
            ],
        });

        // ========================================
        // IAM Roles
        // ========================================

        // EMR Service Role
        const emrServiceRole = new iam.Role(this, 'EmrServiceRole', {
            roleName: `EMR_DefaultRole-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('elasticmapreduce.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonElasticMapReduceRole')],
        });

        // EMR EC2 Role
        const emrEc2Role = new iam.Role(this, 'EmrEc2Role', {
            roleName: `EMR_EC2_DataProcessingRole-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonElasticMapReduceforEC2Role'),
            ],
        });

        // Grant EC2 role access to S3 buckets
        logsBucket.grantReadWrite(emrEc2Role);

        // Grant EC2 role access to KMS key
        s3EncryptionKey.grantEncryptDecrypt(emrEc2Role);

        // EMR EC2 Instance Profile
        const emrEc2InstanceProfile = new iam.CfnInstanceProfile(this, 'EmrEc2InstanceProfile', {
            instanceProfileName: `EMR_EC2_DataProcessingRole-${this.account}-${this.region}`,
            roles: [emrEc2Role.roleName],
        });

        // ========================================
        // EMR Cluster
        // ========================================

        const emrCluster = new emr.CfnCluster(this, 'EmrSparkCluster', {
            name: `Basalt EMR Spark Cluster-${this.account}-${this.region}`,
            releaseLabel: 'emr-5.36.1',
            applications: [{ name: 'Spark' }, { name: 'Zeppelin' }, { name: 'Hadoop' }, { name: 'Pig' }],
            serviceRole: emrServiceRole.roleName,
            jobFlowRole: emrEc2InstanceProfile.ref,
            logUri: `s3n://${logsBucket.bucketName}/clusters/`,
            visibleToAllUsers: true,
            instances: {
                ec2SubnetId: vpc.privateSubnets[0].subnetId,
                emrManagedMasterSecurityGroup: emrManagedPrimarySG.securityGroupId,
                emrManagedSlaveSecurityGroup: emrManagedCoreSG.securityGroupId,
                serviceAccessSecurityGroup: serviceAccessSG.securityGroupId,
                additionalMasterSecurityGroups: [additionalSG.securityGroupId],
                additionalSlaveSecurityGroups: [additionalSG.securityGroupId],
                terminationProtected: false,
                unhealthyNodeReplacement: true,
                masterInstanceFleet: {
                    name: 'MasterInstanceFleet',
                    targetOnDemandCapacity: 1,
                    targetSpotCapacity: 0,
                    instanceTypeConfigs: [
                        { instanceType: 'm5.2xlarge' },
                    ],
                },
                coreInstanceFleet: {
                    name: 'CoreInstanceFleet',
                    targetOnDemandCapacity: 1,
                    targetSpotCapacity: 0,
                    instanceTypeConfigs: [
                        { instanceType: 'm5.2xlarge' },
                    ],
                },
            },
            configurations: [
                {
                    classification: 'emrfs-site',
                    configurationProperties: {
                        'fs.s3.cse.enabled': 'true',
                        'fs.s3.cse.encryptionMaterialsProvider':
                            'com.amazon.ws.emr.hadoop.fs.cse.KMSEncryptionMaterialsProvider',
                        'fs.s3.cse.kms.keyId': s3EncryptionKey.keyArn,
                        'fs.s3.instance.profile.retry.count': '5',
                        'fs.s3.instance.profile.retry.period.seconds': '5',
                    },
                },
                {
                    classification: 'spark',
                    configurationProperties: {
                        maximizeResourceAllocation: 'false',
                    },
                },
                {
                    classification: 'spark-defaults',
                    configurationProperties: {
                        'spark.dynamicAllocation.enabled': 'false',
                        'spark.sql.adaptive.enabled': 'true',
                        'spark.executor.memory': '20G',
                        'spark.yarn.executor.memoryOverhead': '3G',
                        'spark.yarn.maxAppAttempts': '1',
                        'spark.shuffle.service.enabled': 'false',
                        'spark.executor.instances': '425',
                        'spark.executor.cores': '4',
                        'spark.driver.memory': '60G',
                        'spark.driver.maxResultSize': '60G',
                        'spark.sql.autoBroadcastJoinThreshold': '-1',
                        'spark.driver.cores': '8',
                        'spark.sql.shuffle.partitions': '3000',
                        'spark.speculation': 'false',
                    },
                },
            ],
            scaleDownBehavior: 'TERMINATE_AT_TASK_COMPLETION',
            stepConcurrencyLevel: 1,
            tags: [
                { key: 'Environment', value: '0hr2dw3rz' },
                { key: 'Service', value: 'Basalt' },
            ],
        });

        emrCluster.addDependency(emrEc2InstanceProfile);

        // ========================================
        // Stack Outputs
        // ========================================

        StackUtils.exportStack(this, 'EmrClusterId', emrCluster.ref, 'EMR Cluster ID');
        StackUtils.exportStack(this, 'LogsBucketName', logsBucket.bucketName, 'S3 bucket for EMR logs');
        StackUtils.exportStack(this, 'S3EncryptionKeyId', s3EncryptionKey.keyId, 'KMS key ID for S3 encryption');
        StackUtils.exportStack(this, 'EmrServiceRoleArn', emrServiceRole.roleArn, 'EMR service role ARN');
        StackUtils.exportStack(this, 'EmrEc2RoleArn', emrEc2Role.roleArn, 'EMR EC2 role ARN');
    }
}
