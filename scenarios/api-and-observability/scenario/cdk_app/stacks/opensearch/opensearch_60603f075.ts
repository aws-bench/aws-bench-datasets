import * as cdk from 'aws-cdk-lib';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/**
 * VPC-based OpenSearch domain fronted by an internal ALB.
 * The ALB target group uses hardcoded IP targets that pointed at the
 * original OpenSearch ENIs. A subsequent domain config change triggered
 * a blue/green deployment which rotated the ENI IPs, leaving the target
 * group with stale addresses and all health checks failing.
 *
 * Additional complexity:
 * - A CloudWatch alarm monitors the ALB UnHealthyHostCount metric.
 * - VPC Flow Logs are enabled, producing rejected-traffic entries for
 *   the stale IPs (the IPs no longer have listeners on port 443).
 * - A second target group (for port 9200, the OpenSearch REST API)
 *   has the same stale-IP problem.
 * - The OpenSearch security group allows 443 from the ALB SG, so
 *   connectivity *would* work if the IPs were correct.
 */
export class Opensearch_60603f075 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // --- Network ---
        const vpc = new ec2.Vpc(this, 'Vpc', {
            vpcName: `flint-analytics-vpc-${this.account}`,
            ipAddresses: ec2.IpAddresses.cidr('10.80.0.0/16'),
            maxAzs: 2,
            natGateways: 1,
            subnetConfiguration: [
                { cidrMask: 22, name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
                { cidrMask: 22, name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            ],
        });

        // VPC Flow Logs — agent can inspect rejected traffic to stale IPs
        new ec2.FlowLog(this, 'VpcFlowLog', {
            resourceType: ec2.FlowLogResourceType.fromVpc(vpc),
            destination: ec2.FlowLogDestination.toCloudWatchLogs(
                new logs.LogGroup(this, 'FlowLogGroup', {
                    logGroupName: `/aws/vpc/flint-analytics-flowlogs-${this.account}`,
                    retention: logs.RetentionDays.ONE_WEEK,
                    removalPolicy: cdk.RemovalPolicy.DESTROY,
                }),
            ),
        });

        const osSg = new ec2.SecurityGroup(this, 'OpenSearchSg', {
            vpc,
            description: 'OpenSearch domain SG',
            allowAllOutbound: true,
        });

        const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
            vpc,
            description: 'Internal ALB SG',
            allowAllOutbound: true,
        });

        // ALB -> OpenSearch on 443
        osSg.addIngressRule(albSg, ec2.Port.tcp(443), 'HTTPS from ALB');
        // Allow internal VPC traffic to ALB
        albSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(443), 'HTTPS from VPC');

        // --- OpenSearch ---
        const kmsKey = new kms.Key(this, 'OsKey', {
            description: 'Encryption key for flint-analytics OpenSearch',
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const domain = new opensearch.Domain(this, 'AnalyticsDomain', {
            domainName: 'flint-analytics',
            version: opensearch.EngineVersion.OPENSEARCH_2_11,
            capacity: {
                dataNodes: 1,
                dataNodeInstanceType: 't3.small.search',
                multiAzWithStandbyEnabled: false,
            },
            ebs: { enabled: true, volumeSize: 10, volumeType: ec2.EbsDeviceVolumeType.GP3 },
            vpc,
            // Single node -> single subnet (no zone awareness). vpc.privateSubnets
            // are the PRIVATE_WITH_EGRESS subnets; take the first so the one node
            // lands in one AZ.
            vpcSubnets: [{ subnets: vpc.privateSubnets.slice(0, 1) }],
            securityGroups: [osSg],
            encryptionAtRest: { enabled: true, kmsKey },
            nodeToNodeEncryption: true,
            enforceHttps: true,
            tlsSecurityPolicy: opensearch.TLSSecurityPolicy.TLS_1_2,
            fineGrainedAccessControl: {
                masterUserName: 'admin',
                masterUserPassword: cdk.SecretValue.unsafePlainText('QuartzAuth456!'),
            },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        domain.addAccessPolicies(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.AnyPrincipal()],
            actions: ['es:*'],
            resources: [`${domain.domainArn}/*`],
            conditions: {
                StringEquals: { 'aws:PrincipalAccount': cdk.Aws.ACCOUNT_ID },
            },
        }));

        // --- ALB (internal) ---
        const alb = new elbv2.ApplicationLoadBalancer(this, 'AnalyticsAlb', {
            loadBalancerName: 'flint-analytics-alb',
            vpc,
            internetFacing: false,
            securityGroup: albSg,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        });

        // Dashboards target group (port 443) — stale IPs
        const dashboardsTg = new elbv2.ApplicationTargetGroup(this, 'DashboardsTg', {
            targetGroupName: 'flint-dashboards-tg',
            vpc,
            port: 443,
            protocol: elbv2.ApplicationProtocol.HTTPS,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                enabled: true,
                protocol: elbv2.Protocol.HTTPS,
                port: '443',
                path: '/_cluster/health',
                interval: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(10),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 3,
                healthyHttpCodes: '200,301,302',
            },
        });

        // These IPs were valid before the last blue/green deployment
        dashboardsTg.addTarget(new targets.IpTarget('10.80.4.37', 443));
        dashboardsTg.addTarget(new targets.IpTarget('10.80.8.112', 443));

        // REST API target group (port 443, different path) — also stale
        const apiTg = new elbv2.ApplicationTargetGroup(this, 'ApiTg', {
            targetGroupName: 'flint-api-tg',
            vpc,
            port: 443,
            protocol: elbv2.ApplicationProtocol.HTTPS,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                enabled: true,
                protocol: elbv2.Protocol.HTTPS,
                port: '443',
                path: '/',
                interval: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(10),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 3,
                healthyHttpCodes: '200,301,302',
            },
        });

        apiTg.addTarget(new targets.IpTarget('10.80.4.37', 443));
        apiTg.addTarget(new targets.IpTarget('10.80.8.112', 443));

        // HTTP listener with path-based routing
        const httpListener = alb.addListener('HttpListener', {
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            defaultAction: elbv2.ListenerAction.forward([dashboardsTg]),
        });

        httpListener.addAction('ApiRoute', {
            priority: 10,
            conditions: [elbv2.ListenerCondition.pathPatterns(['/_cat/*', '/_cluster/*', '/_nodes/*'])],
            action: elbv2.ListenerAction.forward([apiTg]),
        });

        // --- CloudWatch alarm on unhealthy hosts ---
        const unhealthyAlarm = new cloudwatch.Alarm(this, 'UnhealthyHostsAlarm', {
            alarmName: 'flint-analytics-unhealthy-hosts',
            metric: new cloudwatch.Metric({
                namespace: 'AWS/ApplicationELB',
                metricName: 'UnHealthyHostCount',
                dimensionsMap: {
                    TargetGroup: dashboardsTg.targetGroupFullName,
                    LoadBalancer: alb.loadBalancerFullName,
                },
                statistic: 'Maximum',
                period: cdk.Duration.minutes(1),
            }),
            threshold: 0,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            evaluationPeriods: 2,
            treatMissingData: cloudwatch.TreatMissingData.BREACHING,
        });

        // --- Exports ---
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'VPC ID');
        StackUtils.exportStack(this, 'DomainName', domain.domainName, 'OpenSearch domain name');
        StackUtils.exportStack(this, 'DomainEndpoint', domain.domainEndpoint, 'OpenSearch domain endpoint');
        StackUtils.exportStack(this, 'DomainArn', domain.domainArn, 'OpenSearch domain ARN');
        StackUtils.exportStack(this, 'AlbDnsName', alb.loadBalancerDnsName, 'ALB DNS name');
        StackUtils.exportStack(this, 'AlbArn', alb.loadBalancerArn, 'ALB ARN');
        StackUtils.exportStack(this, 'DashboardsTgArn', dashboardsTg.targetGroupArn, 'Dashboards target group ARN');
        StackUtils.exportStack(this, 'ApiTgArn', apiTg.targetGroupArn, 'API target group ARN');
        StackUtils.exportStack(this, 'AlarmName', unhealthyAlarm.alarmName, 'Unhealthy hosts alarm name');
        StackUtils.exportStack(this, 'FlowLogGroupName', `/aws/vpc/flint-analytics-flowlogs-${this.account}`, 'VPC Flow Log group');
    }
}
