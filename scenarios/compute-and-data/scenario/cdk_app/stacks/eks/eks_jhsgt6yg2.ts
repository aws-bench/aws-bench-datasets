import * as cdk from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { RemovalPolicy } from 'aws-cdk-lib';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: eks_jhsgt6yg2
 * What the stack does:
 * 1. Creates a VPC
 * 2. Creates a IAM role
 * 3. Creates a EKS Cluster
 * */

export class eks_jhsgt6yg2 extends cdk.Stack {
    private readonly accountId: string;

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        this.accountId = this.account;

        // Create VPC
        const vpc = new ec2.Vpc(this, 'EksVPC', {
            maxAzs: 2,
        });
        vpc.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // Create Cluster Role
        const clusterRole = new iam.Role(this, 'ClusterRole', {
            assumedBy: new iam.ServicePrincipal('eks.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSClusterPolicy')],
        });
        clusterRole.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // Create EKS Cluster
        const cluster = new eks.CfnCluster(this, 'Cluster', {
            roleArn: clusterRole.roleArn,
            version: '1.32',
            resourcesVpcConfig: {
                subnetIds: vpc.privateSubnets.map((subnet) => subnet.subnetId),
            },
        });
        cluster.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // Output
        StackUtils.exportStack(this, 'ClusterName', cluster.ref, 'EKS cluster name');
    }
}
