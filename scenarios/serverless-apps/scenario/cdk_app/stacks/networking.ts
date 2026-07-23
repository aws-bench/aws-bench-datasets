import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { StackUtils } from '../lib/shared';

export class NetworkingStack extends cdk.Stack {
    public readonly vpc: ec2.Vpc;
    public readonly alb: elbv2.ApplicationLoadBalancer;

    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // VPC for various resources with NAT Gateway monitoring
        this.vpc = new ec2.Vpc(this, 'ResourcesVpc', {
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

        // Create ALB and S3 bucket for logs
        const albLogsBucket = new s3.Bucket(this, 'alb-access-logs-bucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            enforceSSL: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
        });

        this.alb = new elbv2.ApplicationLoadBalancer(this, 'TestALB', {
            vpc: this.vpc,
            internetFacing: true,
        });
        this.alb.node.addDependency(this.vpc);

        // Enable ALB logging to S3
        this.alb.logAccessLogs(albLogsBucket);

        // Export VPC and ALB resources
        StackUtils.exportStack(this, 'VpcId', this.vpc.vpcId);
        StackUtils.exportStack(this, 'AlbArn', this.alb.loadBalancerArn);
        StackUtils.exportStack(this, 'AlbDnsName', this.alb.loadBalancerDnsName);
        StackUtils.exportStack(this, 'AlbLogsBucketName', albLogsBucket.bucketName);
    }
}
