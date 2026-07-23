import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: eks_ksmvvs901
 * What the stack does:
 1. The stack creates a VPC
 2. The stack creates an IAM role for EKS cluster
 3. The stack creates an auto mode EKS cluster
 4. The stack creates an application load balancer
 */
export class eks_ksmvvs901 extends cdk.Stack {
    private readonly accountId: string;
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        this.accountId = this.account;
        const vpc = new ec2.Vpc(this, 'EksVpc', {
            maxAzs: 2,
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
        vpc.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        const clusterRole = new iam.Role(this, 'ClusterRole', {
            assumedBy: new iam.ServicePrincipal('eks.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSClusterPolicy'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSComputePolicy'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSBlockStoragePolicy'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSLoadBalancingPolicy'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSNetworkingPolicy'),
            ],
        });
        clusterRole.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
        clusterRole.assumeRolePolicy?.addStatements(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                principals: [new iam.ServicePrincipal('eks.amazonaws.com')],
                actions: ['sts:TagSession'],
            }),
        );

        const nodeRole = new iam.Role(this, 'NodeRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodeMinimalPolicy'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryPullOnly'),
            ],
        });
        nodeRole.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        const cluster = new eks.CfnCluster(this, 'EksCluster', {
            version: '1.30',
            roleArn: clusterRole.roleArn,
            resourcesVpcConfig: {
                subnetIds: vpc.privateSubnets.map((subnet) => subnet.subnetId),
            },
            accessConfig: {
                authenticationMode: 'API_AND_CONFIG_MAP',
                bootstrapClusterCreatorAdminPermissions: true,
            },
            computeConfig: {
                enabled: true,
                nodeRoleArn: nodeRole.roleArn,
                nodePools: ['general-purpose'],
            },
            kubernetesNetworkConfig: {
                elasticLoadBalancing: {
                    enabled: true,
                },
            },
            storageConfig: {
                blockStorage: {
                    enabled: true,
                },
            },
        });
        cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        const alb = new elbv2.ApplicationLoadBalancer(this, 'AppLoadBalancer', {
            vpc: vpc,
            internetFacing: false,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        });
        alb.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        StackUtils.exportStack(this, 'VpcId', vpc.vpcId);
        StackUtils.exportStack(this, 'ClusterName', cluster.ref);
        StackUtils.exportStack(this, 'AlbName', alb.loadBalancerName);
    }
}
