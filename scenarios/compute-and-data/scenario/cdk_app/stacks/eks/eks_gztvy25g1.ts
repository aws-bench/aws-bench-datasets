import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: eks_gztvy25g1
 *
 * The stack creates the following resources:
 *
 * 1. Multiple S3 buckets for different services
 * 2. 1 EKS cluster in us-west-2 with Kubernetes v1.33
 * 3. Multiple EKS add-ons

 *
 */

export class eks_gztvy25g1 extends cdk.Stack {
    private readonly accountId: string;

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        this.accountId = this.account;

        // Multiple S3 buckets for different services with versioning
        const services = ['auth', 'api', 'data', 'logs', 'backup', 'analytics'];
        const buckets: s3.Bucket[] = [];
        services.forEach((service) => {
            const bucket = new s3.Bucket(this, `${service}ServiceBucket`, {
                bucketName: `${service}-service-${this.accountId}-${this.region}`,
                versioned: true,
                autoDeleteObjects: true,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
                encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                enforceSSL: true,
            });

            // Add sample objects for deletion testing
            new s3deploy.BucketDeployment(this, `${service}Objects`, {
                sources: [
                    s3deploy.Source.data(`${service}-file1.txt`, 'sample content 1'),
                    s3deploy.Source.data(`${service}-file2.txt`, 'sample content 2'),
                ],
                destinationBucket: bucket,
            });
            bucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
            buckets.push(bucket);
        });

        // Create lifecycle config bucket and script
        const lifecycleBucket = new s3.Bucket(this, 'LifecycleConfigBucket', {
            bucketName: `sagemaker-d9fu-${this.accountId}-${this.region}`,
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
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
                ...buckets.flatMap((b) => [b.bucketArn, `${b.bucketArn}/*`]),
                lifecycleBucket.bucketArn,
                `${lifecycleBucket.bucketArn}/*`,
            ],
        });

        // Upload lifecycle script using AwsCustomResource
        const lifecycleScript = "#!/bin/bash\necho 'HyperPod instance initialized'\n";
        const uploadScript = new cr.AwsCustomResource(this, 'UploadLifecycleScript', {
            onCreate: {
                service: 'S3',
                action: 'putObject',
                parameters: {
                    Bucket: lifecycleBucket.bucketName,
                    Key: 'lifecycle-config.sh',
                    Body: lifecycleScript,
                },
                physicalResourceId: cr.PhysicalResourceId.of('lifecycle-script-upload'),
            },
            policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
                resources: [lifecycleBucket.arnForObjects('*')],
            }),
        });

        // VPC for EKS cluster
        const vpc = new ec2.Vpc(this, 'EksVpc', {
            maxAzs: 2,
            natGateways: 1,
        });
        vpc.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Create EKS service role
        const eksServiceRole = new iam.Role(this, 'EksServiceRole', {
            assumedBy: new iam.ServicePrincipal('eks.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSClusterPolicy')],
        });
        eksServiceRole.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // EKS cluster in us-west-2 with Kubernetes v1.33
        const cluster = new eks.CfnCluster(this, 'EksCluster', {
            name: `eks-cluster-${this.accountId}-${this.region}`,
            version: '1.33',
            roleArn: eksServiceRole.roleArn,
            resourcesVpcConfig: {
                subnetIds: vpc.privateSubnets.map((subnet) => subnet.subnetId),
            },
        });
        cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Multiple EKS add-ons that require individual installation
        const addons = ['vpc-cni', 'coredns', 'kube-proxy', 'aws-ebs-csi-driver'];
        const addonNames: string[] = [];
        addons.forEach((addon) => {
            const eksAddon = new eks.CfnAddon(this, `${addon}Addon`, {
                clusterName: cluster.ref,
                addonName: addon,
            });
            eksAddon.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
            addonNames.push(addon);
        });

        // Create SageMaker execution role
        const sagemakerRole = new iam.Role(this, 'SageMakerExecutionRole', {
            roleName: `SMExecutionRole-${this.accountId}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSageMakerFullAccess')],
        });
        sagemakerRole.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Grant read access to lifecycle bucket
        lifecycleBucket.grantRead(sagemakerRole);


        // Output stack information
        StackUtils.exportStack(this, 'S3BucketNames', buckets.map((b) => b.bucketName).join(','));
        StackUtils.exportStack(this, 'EksClusterName', cluster.ref);
    }
}
