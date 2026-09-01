import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import { StackUtils } from '../lib/shared';
import { NAMES } from './names';

/**
 * Shared network + release metadata plane for the checkout platform.
 *
 * Fargate tasks run in fully isolated subnets and reach ECR / CloudWatch Logs
 * through interface endpoints (no NAT, no internet route).
 */
export class PlatformStack extends cdk.Stack {
    public readonly vpc: ec2.Vpc;
    public readonly releaseRegistry: dynamodb.Table;

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        this.vpc = new ec2.Vpc(this, 'CheckoutVpc', {
            vpcName: NAMES.vpc,
            ipAddresses: ec2.IpAddresses.cidr('10.42.0.0/16'),
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    name: 'workload',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                    cidrMask: 22,
                },
            ],
            enableDnsHostnames: true,
            enableDnsSupport: true,
        });

        const flowLogGroup = new logs.LogGroup(this, 'VpcFlowLogs', {
            logGroupName: '/vpc/checkout-platform/flowlogs',
            retention: logs.RetentionDays.THREE_DAYS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        this.vpc.addFlowLog('FlowLog', {
            destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
            trafficType: ec2.FlowLogTrafficType.REJECT,
        });

        // Endpoint SG: only the VPC itself may talk to the interface endpoints.
        const endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
            vpc: this.vpc,
            securityGroupName: 'checkout-vpce-sg',
            description: 'HTTPS from the checkout VPC to AWS interface endpoints',
            allowAllOutbound: false,
        });
        endpointSg.addIngressRule(
            ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
            ec2.Port.tcp(443),
            'HTTPS from inside the checkout VPC only',
        );

        this.vpc.addInterfaceEndpoint('EcrApiEndpoint', {
            service: ec2.InterfaceVpcEndpointAwsService.ECR,
            securityGroups: [endpointSg],
            privateDnsEnabled: true,
        });
        this.vpc.addInterfaceEndpoint('EcrDockerEndpoint', {
            service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
            securityGroups: [endpointSg],
            privateDnsEnabled: true,
        });
        this.vpc.addInterfaceEndpoint('LogsEndpoint', {
            service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
            securityGroups: [endpointSg],
            privateDnsEnabled: true,
        });
        this.vpc.addGatewayEndpoint('S3Endpoint', {
            service: ec2.GatewayVpcEndpointAwsService.S3,
        });
        this.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
            service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
        });

        // Release metadata written by the build pipelines and the image auditor.
        this.releaseRegistry = new dynamodb.Table(this, 'ReleaseRegistry', {
            tableName: NAMES.registryTable,
            partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        StackUtils.exportStack(this, 'ReleaseRegistryTableName', NAMES.registryTable,
            'DynamoDB table holding release / canary image metadata');
        StackUtils.exportStack(this, 'VpcName', NAMES.vpc, 'Name tag of the checkout platform VPC');
    }
}
